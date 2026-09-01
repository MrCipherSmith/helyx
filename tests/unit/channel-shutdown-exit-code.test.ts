/**
 * `channel.ts` exits with the code the failure actually intended.
 *
 * `shutdown()` used to end its happy path with a bare `process.exit(0)`, no
 * matter which code `leave()` was called with. `leave(1)`'s two callers — a
 * heartbeat that failed to renew the DB lease twice in a row, and a lease
 * lost to a newer channel process — are both error conditions a supervisor
 * watching the exit code needs to tell apart from an ordinary SIGTERM/SIGINT
 * stop. Because `shutdown()`'s two awaited calls
 * (`sessionMgr.markDisconnected()`, `sql.end()`) essentially never reject in
 * practice, `leave()`'s `.catch(() => process.exit(code))` almost never ran
 * either — the process exited 0 on every path.
 *
 * `channel/index.ts` is an entrypoint: importing it runs `main()`, which opens
 * a real Postgres connection and an MCP stdio transport, so there is nothing
 * here for a unit test to import. `limit-not-hang.test.ts`'s last test hits
 * the identical wall for `sessions/manager.ts` (a statement built from a
 * module-level `sql` import) and reads the source text directly instead —
 * this follows the same approach, for the same reason: the property being
 * checked is entirely in the text, and there is no seam to inject a fixture
 * through.
 *
 * F-013 (channel/index.ts:301-321).
 */

import { describe, test, expect } from "bun:test";

async function shutdownBody(): Promise<string> {
  const source = await Bun.file("channel/index.ts").text();
  const start = source.indexOf("const shutdown = async");
  expect(start).toBeGreaterThan(-1);
  const end = source.indexOf("\n  };", start);
  return source.slice(start, end);
}

describe("leave() and shutdown() agree on the exit code", () => {
  test("shutdown takes a code parameter instead of hardcoding 0", async () => {
    const body = await shutdownBody();
    expect(body).toMatch(/const shutdown = async \(code(\s*=\s*0)?\)/);
  });

  test("shutdown's happy path exits with that code, not a literal 0", async () => {
    const body = await shutdownBody();
    expect(body).toContain("process.exit(code)");
    expect(body).not.toContain("process.exit(0)");
  });

  test("leave() threads its own code into shutdown() rather than calling it bare", async () => {
    const source = await Bun.file("channel/index.ts").text();
    const start = source.indexOf("const leave = (code: number) =>");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf("\n  };", start);
    const body = source.slice(start, end);

    expect(body).toContain("shutdown(code)");
    expect(body).not.toMatch(/shutdown\(\)\.catch/);
  });

  test("both leave(1) call sites still request a non-zero exit", async () => {
    // Unchanged by this fix, but the point of threading the code through is
    // moot if nothing upstream still asks for 1.
    const source = await Bun.file("channel/index.ts").text();
    const leaveOneCalls = source.match(/leave\(1\)/g) ?? [];
    expect(leaveOneCalls.length).toBeGreaterThanOrEqual(2);
  });
});
