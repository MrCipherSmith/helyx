/**
 * Which session receives the operator's message.
 *
 * The branch that matters most here is one that must *not* happen: a forum
 * topic with no project mapped returns disconnected rather than falling
 * through to DM routing, because falling through would deliver the message to
 * some other project's session. That rule was guarded by a comment.
 *
 * `tests/unit/forum-topics.test.ts` covered this by reimplementing it — a
 * private copy of the rules that agreed with the original by coincidence and
 * could not notice the original changing. These drive the real function.
 */

import { describe, test, expect } from "bun:test";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { routeMessage, type RouterDeps } from "../../sessions/router.ts";

const CHAT = "-1004440001";
const FORUM_TOPIC = 1158;

interface FakeSession {
  id: number;
  name: string | null;
  status: string;
  clientId: string;
  cliConfig: unknown;
  projectPath: string | null;
}

/** The world the router asks about, and a record of what it changed in it. */
function world(options: {
  topicRows?: Record<string, unknown>[];
  activeSession?: number;
  session?: FakeSession | null;
} = {}) {
  const db = new FakeSql();
  db.program("FROM projects p", { rows: options.topicRows ?? [] });

  const switched: { chatId: string; sessionId: number }[] = [];
  // Every argument recorded, not just the ones a mutation happened to change.
  // The first version of these fakes took none at all, so passing the wrong
  // chat id or looking up the wrong session left all ten tests green — the
  // fake answered correctly regardless of what it was asked.
  const asked = { activeSessionFor: [] as string[], sessionFor: [] as number[] };

  const deps: RouterDeps = {
    sql: db.sql as unknown as RouterDeps["sql"],
    sessions: {
      getActiveSession: async (chatId: string) => {
        asked.activeSessionFor.push(chatId);
        return options.activeSession ?? 0;
      },
      get: async (sessionId: number) => {
        asked.sessionFor.push(sessionId);
        return (options.session ?? null) as never;
      },
      switchSession: async (chatId: string, sessionId: number) => {
        switched.push({ chatId, sessionId });
      },
    } as unknown as RouterDeps["sessions"],
  };

  return { deps, db, switched, asked };
}

const liveSession: FakeSession = {
  id: 7,
  name: "helyx",
  status: "active",
  clientId: "client-7",
  cliConfig: { model: "opus" },
  projectPath: "/home/altsay/bots/helyx",
};

describe("routing by forum topic", () => {
  test("an active session in the topic's project takes the message", async () => {
    const { deps, db } = world({
      topicRows: [{
        path: "/home/altsay/bots/helyx",
        name: "helyx",
        session_id: 7,
        status: "active",
        client_id: "client-7",
        cli_config: { model: "opus" },
      }],
    });

    const route = await routeMessage(CHAT, FORUM_TOPIC, deps);

    // Asked about the topic it was handed, not some other one.
    expect(db.matching("FROM projects p")[0]!.values).toContain(FORUM_TOPIC);
    expect(route).toEqual({
      mode: "cli",
      sessionId: 7,
      clientId: "client-7",
      cliConfig: { model: "opus" },
      projectPath: "/home/altsay/bots/helyx",
    });
  });

  test("a dead session still names its project", async () => {
    // The operator has to be told *which* project is disconnected. Losing the
    // path here turns a specific message into "something is down".
    const { deps } = world({
      topicRows: [{ path: "/home/altsay/keryx", name: "keryx", session_id: 4, status: "ended", client_id: "c", cli_config: {} }],
    });

    const route = await routeMessage(CHAT, FORUM_TOPIC, deps);

    expect(route).toEqual({ mode: "disconnected", sessionId: 4, sessionName: "keryx", projectPath: "/home/altsay/keryx" });
  });

  test("a project with no session at all is disconnected, not routed", async () => {
    const { deps } = world({
      topicRows: [{ path: "/home/altsay/goodai", name: "goodai", session_id: null, status: null, client_id: null, cli_config: null }],
    });

    const route = await routeMessage(CHAT, FORUM_TOPIC, deps);

    expect(route.mode).toBe("disconnected");
    expect(route.sessionId).toBe(0);
  });

  test("an unmapped topic does not fall through to DM routing", async () => {
    // The whole reason this branch exists. With a live DM session waiting,
    // falling through would hand one project's message to another's session —
    // and the operator would have no way to tell it happened.
    const { deps, db, asked } = world({ topicRows: [], activeSession: 7, session: liveSession });

    const route = await routeMessage(CHAT, 9999, deps);

    expect(route).toEqual({ mode: "disconnected", sessionId: 0, sessionName: null, projectPath: null });
    expect(db.count("FROM projects p")).toBe(1);
    // And it never got as far as asking about the DM session.
    expect(asked.activeSessionFor).toEqual([]);
  });
});

describe("routing without a topic", () => {
  test("the General topic is a DM", async () => {
    // Topic 1 is General. Treating it as a project topic would look up a
    // project that cannot exist and strand every message sent there.
    const { deps, db } = world({ activeSession: 7, session: liveSession });

    const route = await routeMessage(CHAT, 1, deps);

    expect(route.mode).toBe("cli");
    expect(db.count("FROM projects p")).toBe(0);
  });

  test("no topic at all is a DM", async () => {
    const { deps } = world({ activeSession: 7, session: liveSession });
    expect((await routeMessage(CHAT, undefined, deps)).mode).toBe("cli");
  });

  test("a chat with no session is standalone", async () => {
    const { deps } = world({ activeSession: 0 });
    expect(await routeMessage(CHAT, undefined, deps)).toEqual({ mode: "standalone", sessionId: 0 });
  });

  test("a session that vanished sends the chat back to standalone", async () => {
    // And says so in the database: leaving the chat pointed at a session that
    // no longer exists means every later message takes this same path.
    const { deps, switched } = world({ activeSession: 7, session: null });

    const route = await routeMessage(CHAT, undefined, deps);

    expect(route).toEqual({ mode: "standalone", sessionId: 0 });
    expect(switched).toEqual([{ chatId: CHAT, sessionId: 0 }]);
  });

  test("a session that is not active is disconnected, and keeps its name", async () => {
    const { deps } = world({
      activeSession: 7,
      session: { ...liveSession, status: "ended" },
    });

    expect(await routeMessage(CHAT, undefined, deps)).toEqual({
      mode: "disconnected",
      sessionId: 7,
      sessionName: "helyx",
      projectPath: "/home/altsay/bots/helyx",
    });
  });

  test("the lookups are made for this chat and this session", async () => {
    // The fakes answer the same either way, so nothing else here notices the
    // router asking about the wrong chat — and asking about the wrong chat is
    // how a message reaches someone else's session.
    const { deps, asked } = world({ activeSession: 7, session: liveSession });

    await routeMessage(CHAT, undefined, deps);

    expect(asked.activeSessionFor).toEqual([CHAT]);
    expect(asked.sessionFor).toEqual([7]);
  });

  test("a live session carries its client id and config", async () => {
    // Both are what the message is actually delivered with; dropping either
    // sends it to the right session over the wrong connection.
    const { deps } = world({ activeSession: 7, session: liveSession });

    expect(await routeMessage(CHAT, undefined, deps)).toEqual({
      mode: "cli",
      sessionId: 7,
      clientId: "client-7",
      cliConfig: { model: "opus" },
      projectPath: "/home/altsay/bots/helyx",
    });
  });
});
