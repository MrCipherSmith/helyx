/**
 * Regression tests for F-001, F-002, F-012 (full-project logic review,
 * 2026-09-01).
 *
 * F-001 — `/remove` (`handleRemove` in bot/commands/session.ts) used to
 * cascade-delete a session's DB history with no check on `session.status`,
 * unlike its sibling `handleDeleteSession` (the inline-button delete path),
 * which refuses on an active session. A live session's history could be
 * deleted out from under it with no guard.
 *
 * F-002 — `disconnect()`'s ephemeral-session branch and
 * `deleteOrphanCliSessions()` (sessions/manager.ts) ran a raw
 * `DELETE FROM sessions` instead of the FK-safe `deleteSessionCascade()`
 * helper. None of the eight tables referencing `sessions(id)` have
 * `ON DELETE CASCADE`, so a session with so much as one referencing row
 * (a message, a permission request, ...) made the raw DELETE throw an
 * unhandled foreign-key violation.
 *
 * F-012 — `disconnect()` invoked `terminationCallback` based only on
 * `newStatus === 'terminated'`, without checking whether `transitionSession`
 * actually applied the transition. A second `disconnect()` on an
 * already-terminated session (e.g. after `markStale()` beat it to the punch)
 * fired a duplicate "session terminated" notification for a no-op transition.
 *
 * Runs against the database `tests/preload.ts` provisions for the run, and
 * skips cleanly when none is reachable — same pattern as
 * tests/unit/reviewer-run.test.ts.
 */

import { describe, test, expect } from "bun:test";
import { sql } from "../../memory/db.ts";
import { sessionManager, setTerminationCallback, type TerminationCallback } from "../../sessions/manager.ts";
import { handleRemove } from "../../bot/commands/session.ts";

const TEST_DATABASE_ENV = "HELYX_TEST_DATABASE";
const hasDatabase = Boolean(process.env[TEST_DATABASE_ENV]);

/** Minimal stand-in for the parts of a grammY context handleRemove reads. */
function ctxFor(text: string): { ctx: any; replies: string[] } {
  const replies: string[] = [];
  const ctx = {
    message: { text },
    reply: async (msg: string) => { replies.push(msg); return {} as any; },
  };
  return { ctx, replies };
}

describe.skipIf(!hasDatabase)("F-001: /remove active-session guard", () => {
  test("refuses to delete an active session, leaving its data intact", async () => {
    const clientId = `f001-active-${Date.now()}-${Math.random()}`;
    const session = await sessionManager.register(clientId, "f001-active", "/tmp/f001-active");
    expect(session.status).toBe("active");

    // A referencing row, so a wrongly-executed delete would be visible.
    await sql`INSERT INTO messages (session_id, chat_id, role, content) VALUES (${session.id}, 'chat-1', 'user', 'hello')`;

    const { ctx, replies } = ctxFor(`/remove ${session.id}`);
    await handleRemove(ctx);

    expect(replies.join("\n")).toContain("Cannot delete active session");

    const [row] = await sql`SELECT id FROM sessions WHERE id = ${session.id}`;
    expect(row).toBeTruthy();
    const [msg] = await sql`SELECT id FROM messages WHERE session_id = ${session.id}`;
    expect(msg).toBeTruthy();
  });

  test("still deletes a non-active session (guard doesn't block the legitimate case)", async () => {
    const clientId = `f001-inactive-${Date.now()}-${Math.random()}`;
    const session = await sessionManager.register(clientId, "f001-inactive", "/tmp/f001-inactive");
    await sql`UPDATE sessions SET status = 'inactive' WHERE id = ${session.id}`;

    const { ctx, replies } = ctxFor(`/remove ${session.id}`);
    await handleRemove(ctx);

    expect(replies.join("\n")).toContain(`Deleted session #${session.id}`);
    const [row] = await sql`SELECT id FROM sessions WHERE id = ${session.id}`;
    expect(row).toBeUndefined();
  });
});

describe.skipIf(!hasDatabase)("F-002: ephemeral/orphan session deletes are FK-safe", () => {
  test("disconnect() on an ephemeral session with a referencing row does not throw, and cleans up both rows", async () => {
    const clientId = `f002-eph-${Date.now()}-${Math.random()}`;
    // No projectPath -> project is null -> isEphemeral branch in disconnect().
    const session = await sessionManager.register(clientId, undefined, undefined);
    expect(session.project).toBeNull();

    await sql`INSERT INTO messages (session_id, chat_id, role, content) VALUES (${session.id}, 'chat-1', 'user', 'hello')`;

    // Before the fix this raw DELETE FROM sessions threw a FK violation
    // (messages.session_id REFERENCES sessions(id), no ON DELETE CASCADE).
    await expect(sessionManager.disconnect(clientId)).resolves.toBeUndefined();

    const [sessionRow] = await sql`SELECT id FROM sessions WHERE id = ${session.id}`;
    expect(sessionRow).toBeUndefined();
    const [msgRow] = await sql`SELECT id FROM messages WHERE session_id = ${session.id}`;
    expect(msgRow).toBeUndefined();
  });

  test("deleteOrphanCliSessions() removes cli-* sessions with a referencing row without throwing", async () => {
    const clientId = `cli-f002-orphan-${Date.now()}-${Math.random()}`;
    const session = await sessionManager.register(clientId, clientId, undefined);
    expect(session.name?.startsWith("cli-")).toBe(true);
    expect(session.project).toBeNull();

    await sql`INSERT INTO messages (session_id, chat_id, role, content) VALUES (${session.id}, 'chat-1', 'user', 'hello')`;

    const deleted = await sessionManager.deleteOrphanCliSessions();
    expect(deleted).toBeGreaterThanOrEqual(1);

    const [sessionRow] = await sql`SELECT id FROM sessions WHERE id = ${session.id}`;
    expect(sessionRow).toBeUndefined();
    const [msgRow] = await sql`SELECT id FROM messages WHERE session_id = ${session.id}`;
    expect(msgRow).toBeUndefined();
  });
});

describe.skipIf(!hasDatabase)("F-012: terminationCallback only fires when the transition actually applied", () => {
  test("a second disconnect() on an already-terminated session does not re-fire the callback", async () => {
    const clientId = `f012-${Date.now()}-${Math.random()}`;
    // projectPath set -> project is truthy -> named/local branch in disconnect(), not the ephemeral one.
    const session = await sessionManager.register(clientId, "f012-session", "/tmp/f012-session");

    const calls: Array<Parameters<TerminationCallback>> = [];
    const previous: TerminationCallback = (id, projectPath, name) => { calls.push([id, projectPath, name]); };
    setTerminationCallback(previous);
    try {
      // First disconnect: active -> terminated (source 'local'), a real transition.
      await sessionManager.disconnect(clientId);
      expect(calls.length).toBe(1);

      const [row] = await sql`SELECT status FROM sessions WHERE id = ${session.id}`;
      expect(row.status).toBe("terminated");

      // Second disconnect: terminated -> terminated is not a valid transition,
      // transitionSession returns false. Before the fix, the callback fired
      // anyway because it only checked newStatus === 'terminated'.
      await sessionManager.disconnect(clientId);
      expect(calls.length).toBe(1);
    } finally {
      // Don't leak this fake callback into other test files sharing the process.
      setTerminationCallback(() => {});
    }
  });
});
