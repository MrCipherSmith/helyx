import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { makePermissionWorld } from "../fixtures/fake-permission-ctx.ts";
import { PermissionHandler } from "../../channel/permissions.ts";

/**
 * Permission flow — driven against the real production functions.
 *
 * [F-001]: this file used to hand-copy `isValidTransition`/`simulateTransition`
 * (standing in for `services/permission-service.ts#transition`) and
 * `isAutoApproved` (standing in for `channel/permissions.ts#isAutoApproved`) as
 * local reimplementations, and every assertion below ran against those copies
 * instead of the named production functions. The copy had already drifted —
 * its `isAutoApproved` only checked `patterns.has(toolName)` and
 * `patterns.has(\`${toolName}(*)\`)`, missing the real function's third branch,
 * which glob-converts any pattern containing `*` to a regex and matches it
 * against the whole tool name — and nothing here would have noticed a further
 * drift, because nothing here ever called the real code. Confirmed live: with
 * that branch disabled in `channel/permissions.ts`, all 55 tests across the
 * four permission-*.test.ts files (this one included) still passed.
 *
 * This file now imports and exercises the real functions:
 *   - `services/permission-service.ts#PermissionService.transition`, against a
 *     `FakeSql` swapped in for `memory/db.ts`'s module-level `sql`, the same
 *     technique `tests/unit/admin-commands.test.ts` uses for services that take
 *     `sql` as a module import rather than a constructor argument.
 *   - `channel/permissions.ts#PermissionHandler.isAutoApproved`, on a handler
 *     built by `makePermissionWorld()` (the fixture `permission-lifecycle.
 *     test.ts` already drives `PermissionHandler` through). `isAutoApproved`
 *     reads a private `autoApprovePatterns` field that production fills from
 *     `settings.local.json` via `loadAutoApproveRules()`; these tests set it
 *     directly so they are about the matching logic itself, not file I/O — the
 *     file-backed path is covered end-to-end elsewhere in the handler's own
 *     test suite.
 */

const DB_MODULE = "../../memory/db.ts";

let db: FakeSql;
let realDb: Record<string, unknown>;
let permissionServiceModule: typeof import("../../services/permission-service.ts");

beforeEach(async () => {
  db = new FakeSql();
  realDb = { ...(await import("../../memory/db.ts")) };
  // Installed per-test and undone in afterEach, never at module scope: a
  // leaked top-level mock.module in this repository has previously bled into
  // other test files sharing the same `bun test` process.
  mock.module(DB_MODULE, () => ({ ...realDb, sql: db.sql }));
  permissionServiceModule = await import("../../services/permission-service.ts");
});

afterEach(() => {
  mock.module(DB_MODULE, () => ({ ...realDb }));
});

describe("PermissionService.transition — valid transitions", () => {
  test("pending → approved is valid (allow callback)", async () => {
    db.program("SELECT status FROM permission_requests", { rows: [{ status: "pending" }] });

    const applied = await new permissionServiceModule.PermissionService().transition("req-1", "approved");

    expect(applied).toBe(true);
    expect(db.count("UPDATE permission_requests SET status = ?")).toBe(1);
  });

  test("pending → rejected is valid (deny callback)", async () => {
    db.program("SELECT status FROM permission_requests", { rows: [{ status: "pending" }] });

    const applied = await new permissionServiceModule.PermissionService().transition("req-1", "rejected");

    expect(applied).toBe(true);
  });

  test("pending → expired is valid (timeout)", async () => {
    db.program("SELECT status FROM permission_requests", { rows: [{ status: "pending" }] });

    const applied = await new permissionServiceModule.PermissionService().transition("req-1", "expired");

    expect(applied).toBe(true);
  });
});

describe("PermissionService.transition — idempotency: duplicate callbacks are no-ops", () => {
  test("approved → approved is rejected (already terminal)", async () => {
    db.program("SELECT status FROM permission_requests", { rows: [{ status: "approved" }] });

    const applied = await new permissionServiceModule.PermissionService().transition("req-1", "approved");

    expect(applied).toBe(false);
    expect(db.count("UPDATE permission_requests SET status = ?")).toBe(0);
  });

  test("approved → rejected is rejected (can't change terminal state)", async () => {
    db.program("SELECT status FROM permission_requests", { rows: [{ status: "approved" }] });

    const applied = await new permissionServiceModule.PermissionService().transition("req-1", "rejected");

    expect(applied).toBe(false);
  });

  test("rejected → approved is rejected (can't reverse denial)", async () => {
    db.program("SELECT status FROM permission_requests", { rows: [{ status: "rejected" }] });

    const applied = await new permissionServiceModule.PermissionService().transition("req-1", "approved");

    expect(applied).toBe(false);
  });

  test("expired → approved is rejected (late callback after timeout)", async () => {
    db.program("SELECT status FROM permission_requests", { rows: [{ status: "expired" }] });

    const applied = await new permissionServiceModule.PermissionService().transition("req-1", "approved");

    expect(applied).toBe(false);
  });

  test("expired → rejected is rejected", async () => {
    db.program("SELECT status FROM permission_requests", { rows: [{ status: "expired" }] });

    const applied = await new permissionServiceModule.PermissionService().transition("req-1", "rejected");

    expect(applied).toBe(false);
  });

  test("second allow callback on an already-approved request leaves status unchanged", async () => {
    // First callback reads 'pending' and applies; the second re-reads the row
    // (now 'approved', per the real UPDATE the first call issued) and is
    // rejected rather than re-applied.
    db.programSequence("SELECT status FROM permission_requests", [
      { rows: [{ status: "pending" }] },
      { rows: [{ status: "approved" }] },
    ]);
    const service = new permissionServiceModule.PermissionService();

    const first = await service.transition("req-1", "approved");
    expect(first).toBe(true);

    const second = await service.transition("req-1", "approved");
    expect(second).toBe(false);
    expect(db.count("UPDATE permission_requests SET status = ?")).toBe(1);
  });

  test("a request that no longer exists cannot be transitioned", async () => {
    db.program("SELECT status FROM permission_requests", { rows: [] });

    const applied = await new permissionServiceModule.PermissionService().transition("gone", "approved");

    expect(applied).toBe(false);
  });
});

describe("PermissionHandler.isAutoApproved — pattern matching", () => {
  function handlerWithPatterns(patterns: string[]): PermissionHandler {
    const world = makePermissionWorld();
    const handler = new PermissionHandler(world.ctx as never, world.status.asStatusManager());
    (handler as unknown as { autoApprovePatterns: Set<string> }).autoApprovePatterns = new Set(patterns);
    return handler;
  }

  test("exact tool name match", () => {
    const handler = handlerWithPatterns(["Read", "Glob"]);
    expect(handler.isAutoApproved("Read")).toBe(true);
    expect(handler.isAutoApproved("Edit")).toBe(false);
  });

  test("wildcard pattern matches all calls to tool", () => {
    const handler = handlerWithPatterns(["Bash(*)"]);
    expect(handler.isAutoApproved("Bash")).toBe(true);
  });

  test("wildcard for one tool does not match another", () => {
    const handler = handlerWithPatterns(["Read(*)"]);
    expect(handler.isAutoApproved("Edit")).toBe(false);
  });

  test("empty patterns set approves nothing", () => {
    const handler = handlerWithPatterns([]);
    expect(handler.isAutoApproved("Read")).toBe(false);
    expect(handler.isAutoApproved("Bash")).toBe(false);
  });

  test("mixed patterns: exact and wildcard", () => {
    const handler = handlerWithPatterns(["Read", "Bash(*)"]);
    expect(handler.isAutoApproved("Read")).toBe(true);
    expect(handler.isAutoApproved("Bash")).toBe(true);
    expect(handler.isAutoApproved("Edit")).toBe(false);
  });

  describe("the general wildcard-regex branch (the one the old hand-copy was missing)", () => {
    test("a namespace glob matches every tool under it", () => {
      const handler = handlerWithPatterns(["mcp__playwright__*"]);
      expect(handler.isAutoApproved("mcp__playwright__browser_click")).toBe(true);
      expect(handler.isAutoApproved("mcp__playwright__browser_navigate")).toBe(true);
    });

    test("a namespace glob does not match a different namespace", () => {
      const handler = handlerWithPatterns(["mcp__playwright__*"]);
      expect(handler.isAutoApproved("mcp__helyx__reply")).toBe(false);
    });

    test("regex special characters in the pattern are escaped, not interpreted", () => {
      // If '.' were left live as regex "any character" instead of escaped,
      // "Notebook.Edit*" would wrongly match a toolName with any character
      // where the literal dot belongs.
      const handler = handlerWithPatterns(["Notebook.Edit*"]);
      expect(handler.isAutoApproved("NotebookXEdit")).toBe(false);
      expect(handler.isAutoApproved("Notebook.Edit")).toBe(true);
    });
  });
});
