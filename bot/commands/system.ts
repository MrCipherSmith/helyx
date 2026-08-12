/**
 * /system — system control panel with inline buttons for start/stop/restart.
 * Admin-only: only the configured TELEGRAM_CHAT_ID may use this.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { sql } from "../../memory/db.ts";
import { renderTmuxHealthLine, TMUX_HEALTH_NAME } from "../../sessions/tmux-server.ts";
import { LEASE_EXPIRY_MS } from "../../utils/restart-lease.ts";
import { GATED_RESTART_COMMANDS } from "../../scripts/restart-gate.ts";
import { beginRestartConfirmation } from "../restart-confirm.ts";

function isAdmin(ctx: Context): boolean {
  const adminChatId = process.env.TELEGRAM_CHAT_ID;
  if (!adminChatId) return false; // fail closed — no config, no access
  // In DMs: chat.id === adminChatId. In forum topics: chat.id is the group id,
  // but from.id is always the user's personal id (same as DM chat id).
  return String(ctx.chat?.id) === adminChatId || String(ctx.from?.id) === adminChatId;
}

async function systemStatus(): Promise<{ lines: string[]; running: boolean; pendingCmd?: string }> {
  const [active, pending, containers] = await Promise.all([
    sql`
      SELECT COUNT(*) AS cnt
      FROM sessions
      WHERE source = 'remote' AND status = 'active' AND id != 0
    `,
    sql`
      SELECT command FROM admin_commands
      WHERE command IN ('tmux_start','tmux_stop','bounce','channel_kill','docker_restart','stack_up','full_restart','docker_restart_all','host_restart')
        AND status IN ('pending','processing')
      ORDER BY created_at DESC
      LIMIT 3
    `,
    // `process_health`, written by admin-daemon every 30s — containers under
    // `docker:<name>`, the host processes under their own names.
    //
    // This read used to be `SELECT name, status FROM health_checks`, a table
    // that has never existed in any migration. The error was swallowed by the
    // `.catch` below, so the panel rendered no health lines at all and looked
    // like a system with nothing to report — while the data sat in another
    // table the whole time. A silent catch around a query is only honest when
    // the empty result means something; here it meant the section was gone.
    sql`
      SELECT name, status, detail, updated_at FROM process_health
      ORDER BY name
    `.catch(() => [] as any[]),
  ]);

  const running = Number(active[0]?.cnt ?? 0) > 0;
  const pendingCmds = (pending as any[]).map((r) => r.command as string);
  const pendingCmd = pendingCmds[0];

  const lines: string[] = ["🖥 System control\n"];

  if (pendingCmds.length > 0) {
    lines.push(`⏳ Pending: ${pendingCmds.join(", ")}`);
  } else if (running) {
    lines.push(`🟢 Sessions: ${Number(active[0]?.cnt ?? 0)} active`);
  } else {
    lines.push("🔴 Sessions: not running");
  }

  lines.push(...renderHealthLines(containers as HealthRow[], Date.now()));

  return { lines, running, pendingCmd };
}

export interface HealthRow {
  name: string;
  status: string | null;
  updated_at: string | Date | null;
  /** JSONB. Only `tmux:bots` carries anything the panel reads. */
  detail?: unknown;
}

/**
 * A heartbeat older than this is not a status, it is the last thing that was
 * true. The writer runs every 30s, so 90s is three missed beats.
 */
export const HEALTH_STALE_MS = 90_000;

/**
 * Which rows the panel shows.
 *
 * `process_health` also carries every other container on the host — the daemon
 * writes whatever `docker ps` returns — and a control panel listing a dozen
 * unrelated containers is one nobody reads. Ours are the compose project's, plus
 * the two host processes that have no container at all.
 */
export const HOST_PROCESSES = ["admin-daemon", "supervisor"] as const;

/**
 * The health section, as lines.
 *
 * Pure and exported because the panel had a whole section that silently
 * rendered nothing for its entire life, and the only way that is caught is by
 * being able to ask what it renders without a bot and a database behind it.
 */
export function renderHealthLines(
  rows: readonly HealthRow[],
  now: number,
  composeProject = process.env.COMPOSE_PROJECT_NAME ?? "helyx",
): string[] {
  const out: string[] = [];

  // The session half first, because it is the half that can be dead while
  // everything else looks fine — and the one the operator could not see during
  // the 2026-08-05 outage. A stale row is worse than none here: it would say
  // "10 windows" about a session killed a minute ago, which is the exact lie
  // this line exists to stop telling.
  const tmuxRow = rows.find((r) => r.name === TMUX_HEALTH_NAME);
  out.push(renderTmuxHealthLine(tmuxRow && !isStale(tmuxRow, now) ? parseTmuxDetail(tmuxRow.detail) : null));

  for (const name of HOST_PROCESSES) {
    const row = rows.find((r) => r.name === name);
    if (!row) {
      out.push(`❔ ${name}: нет данных`);
      continue;
    }
    out.push(`${icon(row, now)} ${name}: ${describe(row, now)}`);
  }

  const containers = rows.filter((r) => r.name.startsWith(`docker:${composeProject}`));
  for (const row of containers) {
    out.push(`${icon(row, now)} ${row.name.slice("docker:".length)}: ${describe(row, now)}`);
  }
  if (containers.length === 0) {
    out.push("❔ контейнеры: нет данных");
  }

  return out;
}

/**
 * `detail` as the panel needs it, or null when it is anything else.
 *
 * postgres.js hands JSONB back as an object or, depending on the column and
 * the driver's mood, as the string it was stored as. Both are handled and
 * everything else — a null, an array, a half-written row from an older daemon —
 * degrades to "нет данных" rather than throwing inside a status panel.
 */
function parseTmuxDetail(detail: unknown): { session: boolean; windows: number; scope: string | null } | null {
  let value = detail;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const d = value as Record<string, unknown>;
  if (typeof d.windows !== "number" || typeof d.session !== "boolean") return null;
  return {
    session: d.session,
    windows: d.windows,
    scope: typeof d.scope === "string" ? d.scope : null,
  };
}

function isStale(row: HealthRow, now: number): boolean {
  if (!row.updated_at) return true;
  return now - new Date(row.updated_at).getTime() > HEALTH_STALE_MS;
}

function isUp(row: HealthRow): boolean {
  const status = String(row.status ?? "").toLowerCase();
  return status === "running" || status === "ok" || status === "healthy";
}

function icon(row: HealthRow, now: number): string {
  if (isStale(row, now)) return "🟡";
  return isUp(row) ? "✅" : "⚠️";
}

function describe(row: HealthRow, now: number): string {
  const status = row.status ?? "unknown";
  return isStale(row, now) ? `${status} (нет свежего heartbeat)` : String(status);
}

export async function handleSystem(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply("⛔ Admin only.");
    return;
  }

  const { lines, running, pendingCmd } = await systemStatus();
  const kb = buildKeyboard(running, !!pendingCmd);
  await ctx.reply(lines.join("\n"), { reply_markup: kb, parse_mode: "HTML" });
}

function buildKeyboard(running: boolean, busy: boolean): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (!busy) {
    if (running) {
      kb.text("🛑 Stop", "sys:stop").text("🔄 Bounce", "sys:bounce");
    } else {
      kb.text("▶️ Start", "sys:start");
    }
    kb.row();
    kb.text("🐳 Restart bot", "sys:restart_bot").text("⚡ Kill channels", "sys:channel_kill");
    // The two that were missing, and whose absence is what made a "restart"
    // mean one half of the system. "Поднять всё" starts whatever is down and
    // leaves what is running alone; "Полный рестарт" rebuilds the bot and then
    // bounces the sessions, so new code reaches both halves.
    kb.row();
    kb.text("🚀 Поднять всё", "sys:stack_up").text("♻️ Полный рестарт", "sys:full_restart");
    // The two halves, named as halves. Everything above either does one thing
    // to one container or does both halves at once; there was no way to say
    // "restart the containers" or "restart everything that is not a container",
    // which is how the operator actually thinks about this system.
    kb.row();
    kb.text("🐳 Рестарт контейнеров", "sys:restart_docker").text("🖥 Рестарт хоста", "sys:restart_host");
  }
  kb.row().text("🔄 Refresh", "sys:refresh");
  return kb;
}

/**
 * The two halves as commands rather than buttons.
 *
 * The panel already had buttons for everything, and during the outage the
 * panel was one of the things that could not be trusted — it counted database
 * rows and reported a session half that was not there. A command that can be
 * typed does not depend on the panel rendering correctly first.
 *
 * Both go through the same `admin_commands` queue as the buttons, so there is
 * one execution path per half and the duplicate guard covers a button and a
 * command racing each other.
 */
async function enqueue(ctx: Context, command: string, label: string, payload: Record<string, unknown> = {}): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply("⛔ Admin only.");
    return;
  }

  // A2 — no teardown-capable command goes straight into the queue any more:
  // each needs a matching, unspent approval grant, and the operator has not
  // seen the fingerprint in words yet. The set is the authority, not a list
  // written out here — `GATED_RESTART_COMMANDS` grew from three commands to
  // eight once "takes the restart lease" stopped being mistaken for "needs
  // approval", and a hardcoded list here would have been left behind.
  if (GATED_RESTART_COMMANDS.has(command)) {
    if (await beginRestartConfirmation(ctx, command, payload)) return;
  }

  // Bounded by the lease expiry, and that bound is what makes leaving the row
  // `processing` safe. A detached restart closes its own row, but it can be
  // killed — and a row that stays `processing` for ever would take this button
  // with it. The lease is the real mutual exclusion; this check exists to
  // explain, and an explanation that outlives the thing it describes is a lie.
  const already = await sql`
    SELECT id FROM admin_commands
    WHERE command = ${command}
      AND status IN ('pending','processing')
      AND created_at > now() - ${`${Math.ceil(LEASE_EXPIRY_MS / 1000)} seconds`}::interval
    LIMIT 1
  `;
  if (already.length > 0) {
    await ctx.reply(`⏳ ${label} — уже выполняется.`);
    return;
  }

  await sql`INSERT INTO admin_commands (command, payload) VALUES (${command}, ${sql.json(payload as any)})`;
  await ctx.reply(`${label}\n\nПрогресс — /system, кнопка 🔄 Refresh.`);
}

/** `/restart_docker` — the container half. */
export async function handleRestartDocker(ctx: Context): Promise<void> {
  await enqueue(ctx, "docker_restart_all", "🐳 Перезапускаю контейнеры (up -d → restart)");
}

/** `/restart_host` — tmux windows, Claude, channel.ts, admin-daemon. */
export async function handleRestartHost(ctx: Context): Promise<void> {
  await enqueue(ctx, "host_restart", "🖥 Перезапускаю всё вне докера (сессии → admin-daemon)");
}

export async function handleSystemCallback(ctx: Context): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.answerCallbackQuery({ text: "Admin only" });
    return;
  }

  const data = ctx.callbackQuery?.data ?? "";
  const action = data.slice("sys:".length);

  if (action === "refresh") {
    await ctx.answerCallbackQuery({ text: "Refreshed" });
    await ctx.deleteMessage().catch(() => {});
    await handleSystem(ctx);
    return;
  }

  const cmdMap: Record<string, { command: string; payload?: Record<string, unknown>; label: string }> = {
    start:        { command: "tmux_start",    payload: {},                                label: "▶️ Starting..." },
    stop:         { command: "tmux_stop",     payload: {},                                label: "🛑 Stopping..." },
    bounce:       { command: "bounce",        payload: {},                                label: "🔄 Bouncing sessions..." },
    restart_bot:  { command: "docker_restart", payload: { container: "helyx-bot-1" },    label: "🐳 Restarting bot..." },
    channel_kill: { command: "channel_kill",  payload: {},                                label: "⚡ Killing channels..." },
    stack_up:     { command: "stack_up",      payload: {},                                label: "🚀 Поднимаю всё..." },
    full_restart: { command: "full_restart",  payload: {},                                label: "♻️ Полный рестарт..." },
    restart_docker: { command: "docker_restart_all", payload: {},                         label: "🐳 Рестарт контейнеров..." },
    restart_host:   { command: "host_restart",       payload: {},                         label: "🖥 Рестарт хоста..." },
  };

  const entry = cmdMap[action];
  if (!entry) {
    await ctx.answerCallbackQuery({ text: "Unknown action" });
    return;
  }

  // A2 — every teardown-capable action in this map goes through a
  // confirmation that states the fingerprint in words first (AC6). The
  // bring-up entries (`stack_up` and friends) keep enqueueing immediately.
  if (GATED_RESTART_COMMANDS.has(entry.command)) {
    if (await beginRestartConfirmation(ctx, entry.command, entry.payload ?? {})) return;
  }

  const already = await sql`
    SELECT id FROM admin_commands
    WHERE command = ${entry.command} AND status IN ('pending','processing')
    LIMIT 1
  `;
  if (already.length > 0) {
    await ctx.answerCallbackQuery({ text: "Already in progress..." });
    return;
  }

  await sql`
    INSERT INTO admin_commands (command, payload)
    VALUES (${entry.command}, ${sql.json((entry.payload ?? {}) as any)})
  `;

  await ctx.answerCallbackQuery({ text: entry.label });
  await ctx.editMessageText(`${entry.label}\n\nUse 🔄 Refresh to check status.`, {
    reply_markup: new InlineKeyboard().text("🔄 Refresh", "sys:refresh"),
    parse_mode: "HTML",
  });
}
