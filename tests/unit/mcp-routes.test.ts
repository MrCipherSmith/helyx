/**
 * What the door says when it says yes.
 *
 * Flow 036 made `mcp/server.ts`'s router reachable and pinned its refusals —
 * who counts as local, the hook token, the transcript path. It stopped there,
 * because everything past a refusal writes to Postgres or starts background
 * work. So the door was proved to say no correctly and nothing at all was
 * proved about it saying yes.
 *
 * These are the yeses, and each one matters to something that has nobody to
 * complain to: `/health` is what the host-ingress daemon arms on,
 * `/api/sessions/register` is how a CLI session comes into existence,
 * `/api/hooks/stop` is what fires fact extraction at the end of every turn, and
 * `/api/hooks/ask-question` holds a socket open for ten minutes waiting for the
 * operator. A 500 with a JSON body reads like an answer to all of them.
 *
 * The error exits are here too, because that is where a dead end would be.
 *
 * Nothing replaces a module: the `McpDeps` seam exists for the reason
 * `bot/media.ts` has one — replacing `memory/db.ts` re-evaluates most of the
 * bot and broke five tests in other files earlier today.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { IncomingMessage, ServerResponse } from "http";
import { handleMcpRequest, setMcpDeps, type McpDeps } from "../../mcp/server.ts";
import { FakeSql } from "../fixtures/fake-sql.ts";

const TOKEN = "test-hook-token";

/** Everything the routes set in motion. */
interface Seen {
  summarized: Array<{ sessionId: unknown; projectPath: unknown }>;
  registered: Array<{ clientId: string; name: string; projectPath: string }>;
  expected: Array<{ sessionId: number; projectPath: string | null }>;
  facts: Array<{ transcript: string; project: string }>;
  summaries: Array<{ transcript: string; project: string }>;
  asked: number;
}

let seen: Seen;
let db: FakeSql;
let restore: (() => void) | undefined;
/** What the question exchange hands back — set per test. */
let answers: unknown[] | null;

interface Answer {
  status: number;
  body: string;
}

function recorder(): { res: ServerResponse; answer: Answer } {
  const answer: Answer = { status: 0, body: "" };
  const res = {
    writeHead(status: number) { answer.status = status; return res; },
    setHeader() {},
    write(chunk: string) { answer.body += chunk; return true; },
    end(chunk?: string) { if (chunk) answer.body += chunk; },
    get headersSent() { return answer.status !== 0; },
    on() { return res; },
    off() { return res; },
  } as unknown as ServerResponse;
  return { res, answer };
}

function request(options: {
  method?: string;
  path: string;
  from?: string;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}): IncomingMessage {
  const raw = options.raw ?? (options.body === undefined ? "" : JSON.stringify(options.body));
  const req = {
    method: options.method ?? "POST",
    url: options.path,
    headers: { host: "localhost:3847", ...(options.headers ?? {}) },
    socket: { remoteAddress: options.from ?? "127.0.0.1" },
    on(event: string, cb: (chunk?: string) => void) {
      if (event === "data" && raw) cb(raw);
      if (event === "end") cb();
      return req;
    },
    off() { return req; },
  } as unknown as IncomingMessage;
  return req;
}

async function answerTo(req: IncomingMessage): Promise<Answer> {
  const { res, answer } = recorder();
  await handleMcpRequest(req, res, null);
  return answer;
}

/** A register that fails, for the exit nobody would try by hand. */
let registerFails = false;

beforeEach(() => {
  seen = { summarized: [], registered: [], expected: [], facts: [], summaries: [], asked: 0 };
  db = new FakeSql();
  answers = null;
  registerFails = false;

  const stubs: Partial<McpDeps> = {
    sql: db.sql as unknown as McpDeps["sql"],
    hookToken: TOKEN,
    summarizeOnDisconnect: (async (sessionId: unknown, projectPath: unknown) => {
      seen.summarized.push({ sessionId, projectPath });
    }) as unknown as McpDeps["summarizeOnDisconnect"],
    registerSession: (async (clientId: string, name: string, projectPath: string) => {
      if (registerFails) throw new Error("session table is gone");
      seen.registered.push({ clientId, name, projectPath });
      return { id: 42, name };
    }) as unknown as McpDeps["registerSession"],
    pushExpect: (async (sessionId: number, projectPath: string | null) => {
      seen.expected.push({ sessionId, projectPath });
    }) as unknown as McpDeps["pushExpect"],
    extractFactsFromTranscript: (async (transcript: string, project: string) => {
      seen.facts.push({ transcript, project });
    }) as unknown as McpDeps["extractFactsFromTranscript"],
    deliverTurnSummary: (async (transcript: string, project: string) => {
      seen.summaries.push({ transcript, project });
    }) as unknown as McpDeps["deliverTurnSummary"],
    runQuestionExchange: (async () => {
      seen.asked++;
      return answers;
    }) as unknown as McpDeps["runQuestionExchange"],
  };

  restore = setMcpDeps(stubs);
});

afterEach(() => { restore?.(); restore = undefined; });

describe("the health probe", () => {
  test("a database that answers is reported connected, with what it is holding", async () => {
    // The host-ingress daemon arms the emergency door on two consecutive
    // failures of this endpoint. It has to be right in both directions.
    db.program("SELECT 1", { rows: [{ "?column?": 1 }] });

    const answer = await answerTo(request({ method: "GET", path: "/health" }));

    expect(answer.status).toBe(200);
    const body = JSON.parse(answer.body);
    expect(body).toMatchObject({ status: "ok", db: "connected" });
    expect(typeof body.uptime).toBe("number");
    expect(typeof body.sessions).toBe("number");
  });

  test("a database that will not answer is 503, not an exception", async () => {
    db.program("SELECT 1", { error: new Error("connection refused") });

    const answer = await answerTo(request({ method: "GET", path: "/health" }));

    expect(answer.status).toBe(503);
    expect(JSON.parse(answer.body)).toMatchObject({ status: "error", db: "disconnected" });
  });
});

describe("summarization on demand", () => {
  test("is accepted and handed on with the session and path it was given", async () => {
    const answer = await answerTo(request({
      path: "/api/summarize",
      body: { session_id: 7, project_path: "/home/altsay/bots/helyx" },
    }));

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ ok: true });
    expect(seen.summarized).toEqual([{ sessionId: 7, projectPath: "/home/altsay/bots/helyx" }]);
  });

  test("without a session id it is 400, and nothing is started", async () => {
    const answer = await answerTo(request({ path: "/api/summarize", body: { project_path: "/home/altsay" } }));

    expect(answer.status).toBe(400);
    expect(seen.summarized).toEqual([]);
  });

  test("a body that is not JSON is answered, not thrown", async () => {
    // The caller is a shell script. An exception here would close the socket
    // with nothing on it, and the script would report success.
    const answer = await answerTo(request({ path: "/api/summarize", raw: "{not json" }));

    expect(answer.status).toBe(500);
    expect(JSON.parse(answer.body).error).toBeTruthy();
  });
});

describe("registering a session", () => {
  test("the session is registered and its id comes back", async () => {
    const answer = await answerTo(request({
      path: "/api/sessions/register",
      body: { projectPath: "/home/altsay/bots/helyx", name: "helyx" },
    }));

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ ok: true, sessionId: 42, name: "helyx" });
    expect(seen.registered).toHaveLength(1);
    expect(seen.registered[0]).toMatchObject({ name: "helyx", projectPath: "/home/altsay/bots/helyx" });
    expect(seen.registered[0]!.clientId).toContain("helyx");
  });

  test("with no name it takes the directory's", async () => {
    await answerTo(request({ path: "/api/sessions/register", body: { projectPath: "/home/altsay/bots/keryx" } }));

    expect(seen.registered[0]!.name).toBe("keryx");
  });

  test("without a project path it is 400", async () => {
    const answer = await answerTo(request({ path: "/api/sessions/register", body: { name: "nowhere" } }));

    expect(answer.status).toBe(400);
    expect(seen.registered).toEqual([]);
  });

  test("a manager that fails is reported as 500 rather than left hanging", async () => {
    registerFails = true;

    const answer = await answerTo(request({
      path: "/api/sessions/register",
      body: { projectPath: "/home/altsay/bots/helyx" },
    }));

    expect(answer.status).toBe(500);
    expect(JSON.parse(answer.body).error).toContain("session table is gone");
  });
});

describe("pre-registering an expected connection", () => {
  test("a numeric session id is accepted and remembered with its path", async () => {
    const answer = await answerTo(request({
      path: "/api/sessions/expect",
      body: { session_id: 4, project_path: "/home/altsay/keryx" },
    }));

    expect(answer.status).toBe(200);
    expect(seen.expected).toEqual([{ sessionId: 4, projectPath: "/home/altsay/keryx" }]);
  });

  test("a session id that is not a number is refused", async () => {
    // channel.ts sends this from a shell, where everything is a string.
    const answer = await answerTo(request({ path: "/api/sessions/expect", body: { session_id: "4" } }));

    expect(answer.status).toBe(400);
    expect(seen.expected).toEqual([]);
  });

  test("a project path that is not absolute is remembered as none", async () => {
    await answerTo(request({ path: "/api/sessions/expect", body: { session_id: 4, project_path: "helyx" } }));

    expect(seen.expected).toEqual([{ sessionId: 4, projectPath: null }]);
  });
});

describe("the Stop hook", () => {
  test("answers before the work runs, and hands both jobs the same paths", async () => {
    // The hook blocks the end of a turn. It gets its 200 immediately and the
    // extraction happens behind it — which is also why a failure in either job
    // can never reach the caller, and why what they are given has to be right.
    const answer = await answerTo(request({
      path: "/api/hooks/stop",
      body: { transcript_path: "/home/altsay/.claude/projects/x/y.jsonl", project_path: "/home/altsay/bots/helyx" },
    }));

    expect(answer.status).toBe(200);
    expect(JSON.parse(answer.body)).toMatchObject({ ok: true });
    expect(seen.facts).toEqual([{ transcript: "/home/altsay/.claude/projects/x/y.jsonl", project: "/home/altsay/bots/helyx" }]);
    expect(seen.summaries).toEqual([{ transcript: "/home/altsay/.claude/projects/x/y.jsonl", project: "/home/altsay/bots/helyx" }]);
  });
});

describe("the ask-question hook", () => {
  const ask = (body: unknown) => request({
    path: "/api/hooks/ask-question",
    headers: { "x-helyx-hook-token": TOKEN },
    body,
  });

  const question = {
    session_id: "abc",
    cwd: "/home/altsay/bots/helyx",
    tool_name: "AskUserQuestion",
    tool_use_id: "tu_1",
    tool_input: {
      questions: [{ question: "Rebuild now?", header: "Deploy", options: [{ label: "Yes" }, { label: "Later" }] }],
    },
  };

  test("the operator's answer comes back as the hook's decision", async () => {
    // An `Answer` is the index of the option chosen — 0 is "Yes" here.
    answers = [0];

    const answer = await answerTo(ask(question));

    expect(seen.asked).toBe(1);
    expect(answer.status).toBe(200);
    const body = JSON.parse(answer.body);
    expect(body.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(body.hookSpecificOutput.permissionDecisionReason).toContain("Yes");
  });

  test("no answer is 204, so the terminal keeps the question", async () => {
    // Timed out or withdrawn. The contract the terminal depends on: the hook
    // prints nothing and Claude Code proceeds as if it had not run.
    answers = null;

    const answer = await answerTo(ask(question));

    expect(seen.asked).toBe(1);
    expect(answer.status).toBe(204);
    expect(answer.body).toBe("");
  });

  test("a payload that is not a question at all is 204, not an error", async () => {
    const answer = await answerTo(ask({ session_id: "abc", tool_name: "Bash", tool_input: {} }));

    expect(seen.asked).toBe(0);
    expect(answer.status).toBe(204);
  });
});
