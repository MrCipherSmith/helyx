/**
 * Who is allowed through the door every MCP call and every hook enters by.
 *
 * `mcp/server.ts` had no tests at all, and could not have had any: its router
 * was an anonymous arrow inside `createServer`, and the only way in was
 * `startMcpHttpServer`, which binds a fixed port — held on this host by the
 * running container — and can call `process.exit(1)` on the way. So the routes
 * were unreachable from a test, and the routes are where the authorization
 * decisions live.
 *
 * The extraction that made this file possible is a move: same body, same route
 * order, one parameter added for the `bot` the arrow used to close over.
 *
 * What is pinned here is the refusals, and only the refusals. The paths that
 * succeed write rows and start summarization in the background; reaching them
 * from a unit test would mean reaching the real database. They need a seam of
 * their own, and this flow says so rather than pretending to cover them.
 */

import { describe, test, expect } from "bun:test";
import type { IncomingMessage, ServerResponse } from "http";
import { handleMcpRequest, isLocalRequest } from "../../mcp/server.ts";

interface Answer {
  status: number;
  body: string;
}

/** A response that records what was written instead of writing it anywhere. */
function recorder(): { res: ServerResponse; answer: Answer } {
  const answer: Answer = { status: 0, body: "" };
  const res = {
    writeHead(status: number) { answer.status = status; return res; },
    setHeader() { /* recorded nowhere: these tests ask only what was decided */ },
    write(chunk: string) { answer.body += chunk; return true; },
    end(chunk?: string) { if (chunk) answer.body += chunk; },
    get headersSent() { return answer.status !== 0; },
    on() { return res; },
  } as unknown as ServerResponse;
  return { res, answer };
}

/**
 * A request from somewhere, carrying a body it hands over the moment it is
 * asked for one — the routes read the body through `req.on("data"|"end")`.
 */
function request(options: {
  method?: string;
  path?: string;
  from?: string;
  body?: unknown;
  headers?: Record<string, string>;
}): IncomingMessage {
  const raw = options.body === undefined ? "" : JSON.stringify(options.body);
  const req = {
    method: options.method ?? "POST",
    url: options.path ?? "/",
    headers: { host: "localhost:3847", ...(options.headers ?? {}) },
    socket: { remoteAddress: options.from ?? "127.0.0.1" },
    on(event: string, cb: (chunk?: string) => void) {
      if (event === "data" && raw) cb(raw);
      if (event === "end") cb();
      return req;
    },
  } as unknown as IncomingMessage;
  return req;
}

const answerTo = async (req: IncomingMessage): Promise<Answer> => {
  const { res, answer } = recorder();
  await handleMcpRequest(req, res, null);
  return answer;
};

describe("who counts as local", () => {
  test("loopback does, in both families and in the mapped form", () => {
    for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
      expect(isLocalRequest({ socket: { remoteAddress: addr } } as IncomingMessage)).toBe(true);
    }
  });

  test("the Docker bridge does, across the whole RFC 1918 range it may land in", () => {
    // Compose picks a subnet from 172.16–31 at will; a check written for
    // 172.17 alone stops working the day a network is recreated.
    for (const addr of ["172.16.0.2", "172.20.0.5", "172.31.255.254"]) {
      expect(isLocalRequest({ socket: { remoteAddress: addr } } as IncomingMessage)).toBe(true);
    }
  });

  test("an address outside it does not, however close", () => {
    for (const addr of ["172.15.0.1", "172.32.0.1", "10.0.0.4", "8.8.8.8", "not-an-address"]) {
      expect(isLocalRequest({ socket: { remoteAddress: addr } } as IncomingMessage)).toBe(false);
    }
  });

  test("a socket with no address at all counts as local", () => {
    // A Unix socket and an in-process request both report nothing. Refusing
    // them would refuse the CLI on the host.
    expect(isLocalRequest({ socket: {} } as IncomingMessage)).toBe(true);
  });
});

describe("a route nobody claims", () => {
  test("is 404, and the answer comes back without a socket or a port", async () => {
    const answer = await answerTo(request({ method: "POST", path: "/nope" }));

    expect(answer.status).toBe(404);
  });
});

describe("the MCP endpoint", () => {
  test("is refused to anything outside loopback and the bridge", async () => {
    // No JWT guards this route on purpose — the CLI could not carry one — so
    // the address check is the entire boundary in front of every tool call.
    const answer = await answerTo(request({ method: "POST", path: "/mcp", from: "203.0.113.7" }));

    expect(answer.status).toBe(403);
    expect(answer.body).toContain("Forbidden");
  });

  test("a local GET without a session id is 400, not a new session", async () => {
    const answer = await answerTo(request({ method: "GET", path: "/mcp" }));

    expect(answer.status).toBe(400);
    expect(answer.body).toContain("Missing session ID");
  });
});

describe("the Stop hook", () => {
  test("is refused from off the machine", async () => {
    const answer = await answerTo(request({
      path: "/api/hooks/stop",
      from: "203.0.113.7",
      body: { transcript_path: "/home/altsay/.claude/x.jsonl", project_path: "/home/altsay/bots/helyx" },
    }));

    expect(answer.status).toBe(403);
  });

  test("without its two fields it is 400, and nothing is started", async () => {
    const answer = await answerTo(request({ path: "/api/hooks/stop", body: { project_path: "/home/altsay" } }));

    expect(answer.status).toBe(400);
    expect(answer.body).toContain("transcript_path");
  });

  test("a transcript path that climbs out of where transcripts live is refused", async () => {
    // The path arrives from a hook and is read off the disk. `/home/..` is
    // still a string beginning with `/home`; only resolving it shows that it
    // is `/etc`. This is the test that would fail if the guard were ever
    // reduced to a prefix check on the raw string.
    const answer = await answerTo(request({
      path: "/api/hooks/stop",
      body: { transcript_path: "/home/../etc/passwd", project_path: "/home/altsay/bots/helyx" },
    }));

    expect(answer.status).toBe(400);
    expect(answer.body).toContain("Invalid transcript_path");
  });
});

describe("the ask-question hook", () => {
  test("a local caller with the wrong shared secret is refused", async () => {
    // Stricter than the other hooks on purpose: this one messages the operator
    // and then holds a socket open for ten minutes, while being local means
    // only "some container on the Docker network".
    const answer = await answerTo(request({
      path: "/api/hooks/ask-question",
      headers: { "x-helyx-hook-token": "not-the-token" },
      body: { question: "may I?" },
    }));

    expect(answer.status).toBe(403);
  });

  test("a local caller carrying no secret at all is refused too", async () => {
    const answer = await answerTo(request({ path: "/api/hooks/ask-question", body: { question: "may I?" } }));

    expect(answer.status).toBe(403);
  });
});

describe("summarization on demand", () => {
  test("is refused to a caller that is neither local nor carrying a token", async () => {
    const answer = await answerTo(request({
      path: "/api/summarize",
      from: "203.0.113.7",
      body: { session_id: 7 },
    }));

    expect(answer.status).toBe(401);
    expect(answer.body).toContain("Unauthorized");
  });
});
