/**
 * The way back in when Docker is down.
 *
 * Every control path into this system runs through the bot container and the
 * Postgres container. When both are down the host daemon is alive with nothing
 * to listen to, and Telegram reaches nothing at all — which is the outage an
 * operator away from the machine cannot do anything about.
 *
 * The door that fixes it is dangerous in two specific ways, and both are what
 * these tests are about. It must never poll Telegram while the bot is polling —
 * one reader per token, or the two take turns losing each other's updates. And
 * it must never confirm what it reads, because confirming destroys the backlog
 * the bot has not processed yet, which during an outage is the operator's own
 * messages.
 */

import { describe, test, expect } from "bun:test";
import {
  HostIngress,
  parseIngressCommand,
  shouldExecute,
  ARM_AFTER_FAILURES,
  COMMAND_MAX_AGE_MS,
  WINDOW,
  type TelegramUpdate,
} from "../../scripts/host-ingress.ts";

const ADMIN = "-1001234";
const NOW = 1_800_000_000_000;

function update(over: Partial<TelegramUpdate["message"]> & { id?: number } = {}): TelegramUpdate {
  const { id, ...message } = over;
  return {
    update_id: id ?? 1,
    message: {
      date: Math.floor(NOW / 1000),
      text: "/up",
      chat: { id: ADMIN },
      from: { id: ADMIN },
      ...message,
    },
  };
}

/** A door with recording fakes for everything it touches. */
function door(opts: { alive: boolean[]; updates?: TelegramUpdate[] }) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const shell: string[] = [];
  let probeIndex = 0;

  const ingress = new HostIngress({
    run: async (cmd: string) => { shell.push(cmd); return { ok: true, output: "ok" }; },
    stack: { botDir: "/srv/helyx", bunBin: "/usr/bin/bun", cli: "/srv/helyx/cli.ts" },
    token: "fake",
    adminChatId: ADMIN,
    probeBot: async () => opts.alive[Math.min(probeIndex++, opts.alive.length - 1)]!,
    telegram: async (method, body) => {
      calls.push({ method, body });
      if (method === "getUpdates") return { result: opts.updates ?? [] };
      return { result: { message_id: 1 } };
    },
    now: () => NOW,
    log: () => {},
  });

  return { ingress, calls, shell };
}

describe("the door stays shut while the bot answers", () => {
  test("a healthy bot never opens it", async () => {
    const { ingress, calls } = door({ alive: [true] });

    for (let i = 0; i < 5; i++) await ingress.probe();
    await ingress.poll();

    expect(ingress.isArmed).toBe(false);
    // Not one getUpdates: a second reader on the token is a 409 that makes both
    // sides lose updates.
    expect(calls.length).toBe(0);
  });

  test("one missed probe is not an outage", async () => {
    // A container restart is a few seconds of refused connections.
    const { ingress } = door({ alive: [false] });

    await ingress.probe();

    expect(ARM_AFTER_FAILURES).toBeGreaterThan(1);
    expect(ingress.isArmed).toBe(false);
  });

  test("but a run of them is", async () => {
    const { ingress } = door({ alive: [false] });

    for (let i = 0; i < ARM_AFTER_FAILURES; i++) await ingress.probe();

    expect(ingress.isArmed).toBe(true);
  });

  test("and it shuts again the moment the bot answers", async () => {
    // Exactly enough failures to arm, then a success — built from the constant
    // so raising it does not turn this into a test of the fixture.
    const { ingress } = door({ alive: [...Array(ARM_AFTER_FAILURES).fill(false), true] });

    for (let i = 0; i < ARM_AFTER_FAILURES; i++) await ingress.probe();
    expect(ingress.isArmed).toBe(true);

    await ingress.probe();

    expect(ingress.isArmed).toBe(false);
  });
});

describe("what counts as the bot being gone", () => {
  test("a bot answering 503 is still a Telegram reader", async () => {
    // The trap this door is most likely to fall into. `/health` returns 503
    // when Postgres is unreachable (mcp/server.ts) while the bot process is
    // alive and still long-polling. Opening a second reader there would 409
    // them both, and the operator's messages would fall between the two.
    //
    // The probe passed to the ingress therefore answers "did anything respond",
    // not "was it healthy" — this asserts the door honours that answer.
    const respondedButUnhealthy = true;
    const { ingress, calls } = door({ alive: [respondedButUnhealthy] });

    for (let i = 0; i < ARM_AFTER_FAILURES + 2; i++) await ingress.probe();
    await ingress.poll();

    expect(ingress.isArmed).toBe(false);
    expect(calls.length).toBe(0);
  });

  test("only a connection that goes nowhere opens it", async () => {
    const { ingress } = door({ alive: [false] });

    for (let i = 0; i < ARM_AFTER_FAILURES; i++) await ingress.probe();

    expect(ingress.isArmed).toBe(true);
  });
});

describe("reading Telegram without destroying the backlog", () => {
  test("no offset is sent while the backlog fits in one window", async () => {
    // `getUpdates` doubles as an acknowledgement: an offset tells Telegram to
    // forget everything before it. During an outage that backlog is the
    // operator's own messages, and the bot has not seen them yet.
    const { ingress, calls } = door({ alive: [false], updates: [update()] });

    for (let i = 0; i < ARM_AFTER_FAILURES; i++) await ingress.probe();
    await ingress.poll();

    const reads = calls.filter((c) => c.method === "getUpdates");
    expect(reads.length).toBe(1);
    expect(reads[0]!.body).not.toHaveProperty("offset");
  });

  test("the same command is not executed twice on a re-read", async () => {
    // Nothing is confirmed, so every poll sees the whole backlog again.
    const { ingress, shell } = door({ alive: [false], updates: [update({ id: 7 })] });

    for (let i = 0; i < ARM_AFTER_FAILURES; i++) await ingress.probe();
    await ingress.poll();
    const afterFirst = shell.length;
    await ingress.poll();

    expect(afterFirst).toBeGreaterThan(0);
    expect(shell.length).toBe(afterFirst);
  });

  test("/up brings the stack up, containers first", async () => {
    const { ingress, shell } = door({ alive: [false], updates: [update()] });

    for (let i = 0; i < ARM_AFTER_FAILURES; i++) await ingress.probe();
    await ingress.poll();

    expect(shell.some((c) => c.includes("docker compose up -d"))).toBe(true);
    expect(shell.some((c) => c.includes("cli.ts") && c.includes(" up"))).toBe(true);
    const compose = shell.findIndex((c) => c.includes("docker compose up -d"));
    const tmux = shell.findIndex((c) => c.includes("cli.ts"));
    expect(compose).toBeLessThan(tmux);
  });
});

describe("who may open it, and with what", () => {
  test("only the admin chat", () => {
    const stranger = update({ chat: { id: "-100999" }, from: { id: "-100999" } });
    expect(shouldExecute(stranger, { adminChatId: ADMIN, now: NOW, seen: new Set() })).toBeNull();
  });

  test("the admin's own id counts, not just the chat", () => {
    // In a forum the chat id is the group's; the sender id is the admin's.
    const inForum = update({ chat: { id: "-100777" }, from: { id: ADMIN } });
    expect(shouldExecute(inForum, { adminChatId: ADMIN, now: NOW, seen: new Set() })).toBe("up");
  });

  test("a command from last week's backlog is history, not an instruction", () => {
    // Nothing is ever confirmed, so an old /up is still pending on Telegram's
    // side and would run again on every daemon start.
    const stale = update({ date: Math.floor((NOW - COMMAND_MAX_AGE_MS - 1000) / 1000) });
    expect(shouldExecute(stale, { adminChatId: ADMIN, now: NOW, seen: new Set() })).toBeNull();
  });

  test("a message with no date is not trusted to be recent", () => {
    const undated = update({ date: undefined });
    expect(shouldExecute(undated, { adminChatId: ADMIN, now: NOW, seen: new Set() })).toBeNull();
  });

  test("the vocabulary is two verbs and nothing else", () => {
    expect(parseIngressCommand("/up")).toBe("up");
    expect(parseIngressCommand("/up@helyx_bot")).toBe("up");
    expect(parseIngressCommand("/поднять")).toBe("up");
    expect(parseIngressCommand("/hstatus")).toBe("status");
    expect(parseIngressCommand("/жив")).toBe("status");
  });

  test("and nothing that reaches a shell", () => {
    // This path runs commands on the host with no database to audit them and no
    // bot to authorise them. Anything outside the whitelist is not a command.
    expect(parseIngressCommand("/restart")).toBeNull();
    expect(parseIngressCommand("/exec rm -rf /")).toBeNull();
    expect(parseIngressCommand("up")).toBeNull();
    expect(parseIngressCommand("")).toBeNull();
    expect(parseIngressCommand(undefined)).toBeNull();
  });

  test("/up and /hstatus are not commands the bot also implements", () => {
    // The backlog is replayed to the bot when it returns. A verb both sides act
    // on would be executed twice.
    for (const verb of ["/up", "/hstatus"]) {
      expect(["/start", "/system", "/projects", "/status", "/session"]).not.toContain(verb);
    }
  });
});

describe("a backlog deeper than one read", () => {
  /** A window's worth of chatter, none of it addressed to this door. */
  function noise(count: number, from = 1): TelegramUpdate[] {
    return Array.from({ length: count }, (_, i) =>
      update({ id: from + i, text: "обычное сообщение", chat: { id: ADMIN }, from: { id: ADMIN } }),
    );
  }

  test("a full window with nothing in it is confirmed, so the read can move past it", async () => {
    // A read without an offset returns the *oldest* hundred unconfirmed
    // updates and never moves. An outage noisy enough to bury the `/up` under
    // a hundred messages would otherwise hide it for ever — silently, in the
    // one situation this door exists for.
    const { ingress, calls } = door({ alive: [false], updates: noise(WINDOW) });

    for (let i = 0; i < ARM_AFTER_FAILURES; i++) await ingress.probe();
    await ingress.poll();
    await ingress.poll();

    const reads = calls.filter((c) => c.method === "getUpdates");
    expect(reads[0]!.body).not.toHaveProperty("offset");
    expect(reads[1]!.body.offset).toBe(WINDOW + 1);
  });

  test("a full window that carried a command is never confirmed, however often it is re-read", async () => {
    // The command was reached, so the backlog around it is still the
    // operator's and still worth keeping.
    //
    // Three polls, not two, and that is the point: the first version of this
    // test stopped at two and passed against code that confirmed the window on
    // the third. Once the command is in `seen` the re-read finds nothing to do,
    // and "nothing to do" is not the same as "nothing was here" — the door
    // would have executed the operator's `/up` and then thrown away the
    // messages that arrived with it.
    const withCommand = [...noise(WINDOW - 1), update({ id: WINDOW })];
    const { ingress, calls } = door({ alive: [false], updates: withCommand });

    for (let i = 0; i < ARM_AFTER_FAILURES; i++) await ingress.probe();
    await ingress.poll();
    await ingress.poll();
    await ingress.poll();

    for (const read of calls.filter((c) => c.method === "getUpdates")) {
      expect(read.body).not.toHaveProperty("offset");
    }
  });

  test("a read that lands after the bot comes back is dropped, not executed", async () => {
    // The bot's own long-poll owns the token from the moment it answers, and a
    // command executed here after that would be executed a second time when
    // the bot replays the backlog nobody confirmed.
    //
    // Built by hand rather than through `door`: the read has to still be in
    // flight when the probe succeeds, and that means holding the answer open.
    const shell: string[] = [];
    let release: (value: unknown) => void = () => {};
    const held = new Promise((resolve) => { release = resolve; });
    let alive = false;

    const ingress = new HostIngress({
      run: async (cmd: string) => { shell.push(cmd); return { ok: true, output: "ok" }; },
      stack: { botDir: "/srv/helyx", bunBin: "/usr/bin/bun", cli: "/srv/helyx/cli.ts" },
      token: "fake",
      adminChatId: ADMIN,
      probeBot: async () => alive,
      telegram: async (method) => {
        if (method !== "getUpdates") return { result: { message_id: 1 } };
        await held;
        return { result: [update({ id: 5 })] };
      },
      now: () => NOW,
      log: () => {},
    });

    for (let i = 0; i < ARM_AFTER_FAILURES; i++) await ingress.probe();
    const reading = ingress.poll();

    alive = true;
    await ingress.probe();
    expect(ingress.isArmed).toBe(false);

    release(null);
    await reading;

    expect(shell).toEqual([]);
  });

  test("a window that is not full is never confirmed, however often it is read", async () => {
    const { ingress, calls } = door({ alive: [false], updates: noise(3) });

    for (let i = 0; i < ARM_AFTER_FAILURES; i++) await ingress.probe();
    await ingress.poll();
    await ingress.poll();
    await ingress.poll();

    for (const read of calls.filter((c) => c.method === "getUpdates")) {
      expect(read.body).not.toHaveProperty("offset");
    }
  });
});
