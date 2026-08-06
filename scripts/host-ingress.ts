/**
 * The way back in when Docker is down.
 *
 * Every control path into this system runs through the bot, and the bot is a
 * container. It writes to `admin_commands`, which lives in Postgres, which is
 * also a container. The host-side daemon that executes those commands survives
 * anything — it is a systemd user unit with linger — but it only ever reads
 * that queue. So the moment the stack is down, the daemon is alive and has no
 * inbox, and Telegram reaches nothing at all. An operator away from the machine
 * has no way to bring it back.
 *
 * This is the second door. It polls Telegram directly from the host, and it is
 * closed the entire time the bot is answering.
 *
 * ## Why it only opens when the bot is down
 *
 * Telegram allows one `getUpdates` reader per token: a second one gets 409
 * Conflict, and the two then take turns losing each other's updates. So this
 * must never poll alongside the bot. It arms only after the bot has failed
 * `ARM_AFTER_FAILURES` consecutive health probes, and disarms on the first
 * successful one.
 *
 * ## Why it does not confirm what it reads
 *
 * `getUpdates` doubles as an acknowledgement: passing an offset tells Telegram
 * to forget everything before it. If this confirmed what it read, every message
 * that arrived during the outage would be destroyed on the way past — the
 * operator's questions included, which is precisely the traffic an outage
 * strands. It reads without an offset and remembers what it has acted on in
 * memory, so Telegram keeps the whole backlog and hands it to the bot when the
 * bot comes back.
 *
 * A negative offset would be the obvious way to always see the newest update;
 * it is not used deliberately, because Telegram documents it as forgetting all
 * previous updates, which is the same destruction by another route.
 *
 * ## The one case where it does confirm
 *
 * A read without an offset returns the *oldest* hundred unconfirmed updates,
 * and it never moves on its own. So a backlog deeper than that would hide the
 * operator's `/up` behind it for ever. When the window comes back full and
 * holds nothing for this door, it confirms through the end of that window to
 * reach newer updates — trading the stranded chat history for the recovery it
 * exists to perform. A backlog that fits, or one that carried a command, costs
 * the operator nothing.
 */

import { bringStackUp, type RunShell, type StackUpOptions } from "./stack-up.ts";
import { takeRestartLease, releaseRestartLease, heldMessage } from "../utils/restart-lease.ts";

/** Consecutive failed probes before the door opens. */
export const ARM_AFTER_FAILURES = 2;
/** How often the bot is probed. */
export const PROBE_INTERVAL_MS = 20_000;
/** How often Telegram is read while armed. */
export const POLL_INTERVAL_MS = 5_000;
/**
 * How far back a command may be and still be executed.
 *
 * The backlog is never confirmed, so it is still there on the next daemon
 * start — and without this an `/up` sent during last week's outage would run
 * again every time the daemon restarts. A command older than this is history.
 */
export const COMMAND_MAX_AGE_MS = 15 * 60_000;
/**
 * How many updates one read may return — Telegram's own maximum.
 *
 * Named because it is also the depth at which the backlog stops fitting in a
 * single window, which is the condition `poll` has to notice.
 */
export const WINDOW = 100;
/** How many update ids are remembered. Enough for any single outage. */
export const SEEN_CAPACITY = 500;

/** For asking `shouldExecute` what a window held, rather than what is left to do. */
const NOTHING_SEEN: ReadonlySet<number> = new Set<number>();

export interface TelegramUpdate {
  update_id: number;
  message?: {
    date?: number;
    text?: string;
    chat?: { id?: number | string };
    from?: { id?: number | string };
    message_thread_id?: number;
  };
}

export interface HostIngressDeps {
  run: RunShell;
  stack: StackUpOptions;
  token: string;
  /** The only chat allowed to command this door. Matched against chat id and sender id. */
  adminChatId: string;
  /** Probe the bot. True when it is answering. */
  probeBot: () => Promise<boolean>;
  /** Injected so tests do not talk to Telegram, and so the caller owns the timeout policy. */
  telegram: (method: string, body: Record<string, unknown>) => Promise<any | null>;
  now?: () => number;
  log?: (message: string) => void;
}

/** What a message asks for, or null when it asks for nothing this door offers. */
export type IngressCommand = "up" | "status";

/**
 * The whitelist, and it is short on purpose.
 *
 * This path runs shell commands on the host with no Postgres to audit them and
 * no bot to authorise them. Two verbs — bring everything up, and say what is
 * running — are enough to recover from an outage, and every additional verb is
 * one more thing reachable by whoever gets hold of the token.
 *
 * `/up` and `/hstatus` are also deliberately not commands the bot implements.
 * The backlog is replayed to the bot when it returns, and a command that means
 * something to both would be executed twice.
 */
export function parseIngressCommand(text: string | undefined): IngressCommand | null {
  const first = (text ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const bare = first.split("@")[0]; // /up@helyx_bot
  if (bare === "/up" || bare === "/поднять") return "up";
  if (bare === "/hstatus" || bare === "/жив") return "status";
  return null;
}

/**
 * Whether this update is a command this door should execute now.
 *
 * Three independent reasons to refuse, and each one has teeth: a message from
 * anyone but the admin, a command replayed from a backlog older than the
 * outage, and one already acted on.
 */
export function shouldExecute(
  update: TelegramUpdate,
  ctx: { adminChatId: string; now: number; seen: ReadonlySet<number> },
): IngressCommand | null {
  if (ctx.seen.has(update.update_id)) return null;

  const message = update.message;
  if (!message) return null;

  const chatId = String(message.chat?.id ?? "");
  const fromId = String(message.from?.id ?? "");
  if (chatId !== ctx.adminChatId && fromId !== ctx.adminChatId) return null;

  // Telegram sends seconds. A message with no date is not trusted to be recent.
  const sentAtMs = typeof message.date === "number" ? message.date * 1000 : null;
  if (sentAtMs === null || ctx.now - sentAtMs > COMMAND_MAX_AGE_MS) return null;

  return parseIngressCommand(message.text);
}

/**
 * The door itself: a probe loop, and a poll loop that only runs while armed.
 *
 * Split from the timers below so the decisions can be stepped one call at a
 * time. The version of this that lived in a closure could only be tested by
 * taking the bot down.
 */
export class HostIngress {
  private failures = 0;
  private armed = false;
  private readonly seen = new Set<number>();
  /**
   * The last update id this door has confirmed to Telegram, or null while it
   * has confirmed nothing — which is the normal case and the one the module
   * note describes.
   */
  private confirmedThrough: number | null = null;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(private readonly deps: HostIngressDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.log = deps.log ?? ((m) => console.error(`[host-ingress] ${m}`));
  }

  get isArmed(): boolean {
    return this.armed;
  }

  /** One health probe. Arms or disarms the door. */
  async probe(): Promise<boolean> {
    const alive = await this.deps.probeBot().catch(() => false);
    if (alive) {
      if (this.armed) {
        this.log("bot is answering again — closing the host door");
        this.armed = false;
      }
      this.failures = 0;
      return true;
    }

    this.failures++;
    if (!this.armed && this.failures >= ARM_AFTER_FAILURES) {
      this.armed = true;
      this.log(`bot has missed ${this.failures} probes — opening the host door`);
    }
    return false;
  }

  /** One Telegram read. Does nothing while the bot is answering. */
  async poll(): Promise<void> {
    if (!this.armed) return;

    // No offset while the backlog fits in one window: see the note on this
    // module. `limit` is Telegram's maximum, and the window it returns is the
    // *oldest* hundred unconfirmed updates — which is why `confirmedThrough`
    // below exists.
    const result = await this.deps.telegram("getUpdates", {
      limit: WINDOW,
      timeout: 0,
      allowed_updates: ["message"],
      ...(this.confirmedThrough === null ? {} : { offset: this.confirmedThrough + 1 }),
    });
    const updates: TelegramUpdate[] = Array.isArray(result?.result) ? result.result : [];

    // The bot may have come back while this read was in flight. Its own
    // long-poll owns the token from that moment, and a command executed here
    // now would be executed again by the bot when it replays the backlog.
    if (!this.armed) return;

    let carriedCommand = false;

    for (const update of updates) {
      const ctx = { adminChatId: this.deps.adminChatId, now: this.now() };
      const command = shouldExecute(update, { ...ctx, seen: this.seen });
      // Asked a second time without the memory: a command already acted on is
      // still a command this window carried. Without that distinction the
      // window would be confirmed on the *next* poll — the door would execute
      // the operator's `/up` and then throw away the messages that arrived
      // with it, which is exactly what confirming was supposed to avoid.
      if (command ?? shouldExecute(update, { ...ctx, seen: NOTHING_SEEN })) carriedCommand = true;
      // Remembered whether or not it was ours: a backlog is re-read on every
      // poll, and re-parsing the same hundred updates every five seconds is
      // work nobody asked for.
      this.remember(update.update_id);
      if (!command) continue;

      this.log(`executing /${command} from the host door`);
      await this.execute(command, update).catch((err) => this.log(`command failed: ${err}`));
    }

    // The window is Telegram's *oldest* hundred unconfirmed updates, and
    // without an offset it never moves. So a backlog deeper than a hundred
    // would hide the operator's `/up` behind it for ever — silently, in
    // exactly the outage this door exists for, which is the worst place for a
    // silent failure.
    //
    // Only an offset moves the window, and an offset confirms: the chat
    // history stranded by the outage is lost to the bot. That is the trade,
    // and it is taken only when the window came back full and held nothing for
    // us. A backlog that fits, or one that contained a command, still costs
    // the operator nothing.
    if (!carriedCommand && updates.length >= WINDOW) {
      const last = updates[updates.length - 1]!;
      this.confirmedThrough = last.update_id;
      this.log(`backlog full and no command in it — confirming through ${last.update_id} to reach newer updates`);
    }
  }

  private remember(updateId: number): void {
    this.seen.add(updateId);
    if (this.seen.size > SEEN_CAPACITY) {
      // Insertion-ordered, so the oldest ids go first.
      for (const id of this.seen) {
        this.seen.delete(id);
        if (this.seen.size <= SEEN_CAPACITY) break;
      }
    }
  }

  private async execute(command: IngressCommand, update: TelegramUpdate): Promise<void> {
    const threadId = update.message?.message_thread_id;
    const chatId = String(update.message?.chat?.id ?? this.deps.adminChatId);

    if (command === "status") {
      await this.reply(chatId, threadId, await this.hostStatus());
      return;
    }

    // The same lease the admin daemon takes, for the reason it is a file and
    // not a row: this door is armed when the bot is confirmed dead, and the
    // daemon does not stop when the bot does — it may be minutes into a
    // `host_restart` right now, with its own database connection. Running a
    // second bring-up over that is the race this guards. Raised in review.
    const lease = takeRestartLease("/up", undefined, Date.now());
    if (!lease.ok) {
      await this.reply(chatId, threadId, `⏳ ${heldMessage(lease.held)}`);
      return;
    }
    if (lease.broke) {
      console.error(`[host-ingress] broke stale lease from ${lease.broke.owner}`);
    }

    try {
      // Inside the try, not before it: a reply that throws — and this one goes
      // over the network to Telegram, in the middle of an outage — would
      // otherwise exit past the `finally` and strand the lease for the whole
      // expiry, locking the operator out of the door they opened to recover.
      // Raised in review.
      await this.reply(chatId, threadId, "🔧 Поднимаю стек с хоста — контейнеры, затем сессии…");
      const result = await bringStackUp(this.deps.run, this.deps.stack);
      const head = result.ok ? "✅ Стек поднят" : "⚠️ Поднял не всё";
      await this.reply(chatId, threadId, `${head}\n\n<pre>${escapeHtml(result.summary.slice(0, 3000))}</pre>`);
    } finally {
      // In a `finally`: a bring-up that throws must not leave the lease behind
      // for fifteen minutes, which is the whole window an operator would be
      // locked out of the door they opened to recover.
      releaseRestartLease();
    }
  }

  /** What is running, as seen from the host rather than from the database. */
  private async hostStatus(): Promise<string> {
    const docker = await this.deps.run(`timeout 15 docker ps --format '{{.Names}}\t{{.Status}}' 2>&1 || true`);
    const tmux = await this.deps.run(`timeout 10 tmux list-windows -t bots -F '#{window_name}' 2>&1 || true`);
    const body = [
      "🐳 Контейнеры:",
      docker.output.trim() || "(ничего не запущено)",
      "",
      "🖥 Окна tmux:",
      tmux.output.trim() || "(сессии bots нет)",
    ].join("\n");
    return `🩺 Хостовый статус\n<pre>${escapeHtml(body.slice(0, 3000))}</pre>`;
  }

  private async reply(chatId: string, threadId: number | undefined, text: string): Promise<void> {
    const body: Record<string, unknown> = { chat_id: chatId, text, parse_mode: "HTML" };
    if (threadId) body.message_thread_id = threadId;
    await this.deps.telegram("sendMessage", body).catch(() => null);
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Wire the door to timers.
 *
 * Both are unref'd: this is a watchdog, and it must never be the reason the
 * daemon stays alive.
 */
export function startHostIngress(deps: HostIngressDeps): { ingress: HostIngress; stop: () => void } {
  const ingress = new HostIngress(deps);

  let probing = false;
  const probeTimer = setInterval(() => {
    if (probing) return;
    probing = true;
    ingress.probe().catch(() => {}).finally(() => { probing = false; });
  }, PROBE_INTERVAL_MS);
  probeTimer.unref?.();

  let polling = false;
  const pollTimer = setInterval(() => {
    if (polling) return;
    polling = true;
    ingress.poll().catch(() => {}).finally(() => { polling = false; });
  }, POLL_INTERVAL_MS);
  pollTimer.unref?.();

  return {
    ingress,
    stop: () => { clearInterval(probeTimer); clearInterval(pollTimer); },
  };
}
