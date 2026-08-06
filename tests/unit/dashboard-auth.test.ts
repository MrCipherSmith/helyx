/**
 * The two guards in front of the only surface reachable from outside.
 *
 * `mcp/dashboard-api.ts` is the largest untested file in the repository — 947
 * uncovered lines — and every route under `/api/` is reachable from a browser.
 * Its dispatcher decides whether a request is answered at all: a JWT check on
 * everything under `/api/`, and an Origin check on anything that changes state.
 *
 * Neither was tested. A change that let one of them through would have been
 * invisible until somebody noticed data leaving.
 *
 * The JWT here is real — signed by the same module that verifies it — so these
 * prove the gate opens for a genuine token rather than that a mock said yes.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage, ServerResponse } from "http";
import { handleDashboardRequest } from "../../mcp/dashboard-api.ts";
import { signJwt } from "../../dashboard/auth.ts";

/**
 * The SPA the dispatcher serves, guaranteed rather than assumed.
 *
 * `dashboard/dist` is a build artifact: gitignored, sitting there on a machine
 * that has run the build, absent on a clean checkout. The asset test below
 * asserts that an `/index.html` request is answered, which on CI was an
 * assertion about a directory that did not exist — it failed there and only
 * there, for a day, while passing on every developer's machine.
 *
 * A real build is not what that test is about, so it does not wait for one. The
 * one file it needs is written when it is missing, and only what was written is
 * removed afterwards: a checkout that has a real dashboard keeps it.
 */
const DIST_DIR = join(import.meta.dir, "../../dashboard/dist");
const DIST_INDEX = join(DIST_DIR, "index.html");
let createdIndex = false;
let createdDir = false;

beforeAll(() => {
  if (existsSync(DIST_INDEX)) return;
  createdDir = !existsSync(DIST_DIR);
  mkdirSync(DIST_DIR, { recursive: true });
  writeFileSync(DIST_INDEX, "<!doctype html><title>dashboard</title>\n");
  createdIndex = true;
});

afterAll(() => {
  if (createdIndex) rmSync(DIST_INDEX, { force: true });
  if (createdDir) rmSync(DIST_DIR, { force: true, recursive: true });
});

/**
 * A route under `/api/` that no handler claims.
 *
 * The guards run before dispatch, so this reaches both of them and then nothing
 * — which is exactly what these tests want. The first version replaced the
 * database module instead, so that a real handler could run against a fake
 * `sql`; that mock is process-wide and leaked into five tests in other files.
 * Not reaching a handler at all is both safer and a sharper question: it asks
 * only what the guards did.
 */
const UNCLAIMED = "/api/no-such-route";

interface Answer {
  status: number;
  body: string;
  headers: Record<string, unknown>;
}

/** A response that records what was written instead of writing it anywhere. */
function recorder(): { res: ServerResponse; answer: Answer } {
  const answer: Answer = { status: 0, body: "", headers: {} };
  const res = {
    writeHead(status: number, headers?: Record<string, unknown>) {
      answer.status = status;
      Object.assign(answer.headers, headers ?? {});
      return res;
    },
    setHeader(name: string, value: unknown) { answer.headers[name] = value; },
    write(chunk: string) { answer.body += chunk; return true; },
    end(chunk?: string) { if (chunk) answer.body += chunk; },
    on() { return res; },
  } as unknown as ServerResponse;
  return { res, answer };
}

function request(options: {
  method?: string;
  path?: string;
  cookie?: string;
  bearer?: string;
  origin?: string;
  host?: string;
}): { req: IncomingMessage; url: URL } {
  const path = options.path ?? "/api/overview";
  const headers: Record<string, string> = { host: options.host ?? "localhost:3847" };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.bearer) headers.authorization = `Bearer ${options.bearer}`;
  if (options.origin) headers.origin = options.origin;

  const req = {
    method: options.method ?? "GET",
    url: path,
    headers,
    // Body-reading routes attach listeners; nothing here ever sends a body.
    on(event: string, cb: () => void) { if (event === "end") cb(); return req; },
  } as unknown as IncomingMessage;

  return { req, url: new URL(path, "http://localhost:3847") };
}

const token = () => signJwt({ userId: 1, username: "operator" } as never);

const past = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
  await handleDashboardRequest(req, res, url);
};

describe("what the dispatcher owns", () => {
  test("a request that matches nothing is handed back to the caller", async () => {
    // False means "not mine". The first version of this test used an asset path
    // and failed, which is how the real contract came to light: this dispatcher
    // *is* the static file server, so an asset is its own.
    const { req, url } = request({ method: "POST", path: "/not-a-route" });
    const { res } = recorder();

    expect(await handleDashboardRequest(req, res, url)).toBe(false);
  });

  test("a dashboard asset is served by this dispatcher, not passed on", async () => {
    const { req, url } = request({ path: "/index.html" });
    const { res } = recorder();

    expect(await handleDashboardRequest(req, res, url)).toBe(true);
  });
});

describe("the auth gate", () => {
  test("no credentials is 401, and the request is answered rather than passed on", async () => {
    const { req, url } = request({});
    const { res, answer } = recorder();

    const handled = await handleDashboardRequest(req, res, url);

    expect(handled).toBe(true);
    expect(answer.status).toBe(401);
    expect(answer.body).toContain("Unauthorized");
  });

  test("a genuine token in a cookie is served", async () => {
    // Signed by the module that verifies it: this proves the gate opens for a
    // real token, not that a double agreed with itself.
    const { req, url } = request({ path: UNCLAIMED, cookie: `token=${await token()}` });
    const { res, answer } = recorder();

    await past(req, res, url);

    expect(answer.status).not.toBe(401);
  });

  test("the same token as a Bearer header is served too", async () => {
    // The Mini App sends it this way; the browser sends a cookie. Both are the
    // same credential and both must work.
    const { req, url } = request({ path: UNCLAIMED, bearer: await token() });
    const { res, answer } = recorder();

    await past(req, res, url);

    expect(answer.status).not.toBe(401);
  });

  test("a forged token is no token", async () => {
    const { req, url } = request({ cookie: "token=not.a.jwt" });
    const { res, answer } = recorder();

    await handleDashboardRequest(req, res, url);

    expect(answer.status).toBe(401);
  });

  test("a token signed with the wrong key is no token", async () => {
    // Three well-formed base64 segments, and a signature that is not ours.
    const forged = `${btoa('{"alg":"HS256"}')}.${btoa('{"userId":1}')}.bm90LWEtc2lnbmF0dXJl`;
    const { req, url } = request({ cookie: `token=${forged}` });
    const { res, answer } = recorder();

    await handleDashboardRequest(req, res, url);

    expect(answer.status).toBe(401);
  });
});

describe("the CSRF guard", () => {
  test("a state-changing request from a foreign origin is refused even with a valid token", async () => {
    const { req, url } = request({
      method: "POST",
      path: "/api/sessions/1/switch",
      cookie: `token=${await token()}`,
      origin: "https://evil.example",
      host: "localhost:3847",
    });
    const { res, answer } = recorder();

    const handled = await handleDashboardRequest(req, res, url);

    expect(handled).toBe(true);
    expect(answer.status).toBe(403);
    expect(answer.body).toContain("origin");
  });

  test("the same request from the host it claims is not refused by that guard", async () => {
    const { req, url } = request({
      method: "POST",
      path: UNCLAIMED,
      cookie: `token=${await token()}`,
      origin: "http://localhost:3847",
      host: "localhost:3847",
    });
    const { res, answer } = recorder();

    await past(req, res, url);

    expect(answer.status).not.toBe(403);
  });

  test("a GET is not subject to the origin check", async () => {
    // Reading is not a state change, and a dashboard opened from a bookmark
    // sends no Origin at all.
    const { req, url } = request({ path: UNCLAIMED, cookie: `token=${await token()}`, origin: "https://elsewhere.example" });
    const { res, answer } = recorder();

    await past(req, res, url);

    expect(answer.status).not.toBe(403);
  });
});
