/**
 * A2 — approval bound to an action, run against a real database.
 *
 * `presentGrant`'s single-use consumption is an atomic `UPDATE ... WHERE
 * consumed_at IS NULL`, and a fake `sql` that matches on query text rather
 * than executing SQL cannot prove that race-safety — the same trap
 * `multi-answer-toggle.test.ts` documents for `answers -> '0'`. So this uses
 * `tests/fixtures/test-db.ts`, which provisions a disposable database and
 * skips cleanly when none is reachable.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { databaseAvailable, provisionTestDatabase, NO_DATABASE_MESSAGE, type TestDatabase } from "../fixtures/test-db.ts";
import {
  fingerprintOf,
  fingerprintsEqual,
  describeFingerprint,
  confirmationText,
  issueOperatorGrant,
  issueStandingGrant,
  getGrant,
  presentGrant,
  cancelGrant,
  authorizeAutonomousAction,
  toApprovalGrant,
  type ActionFingerprint,
} from "../../utils/action-approval-grant.ts";

// ---------------------------------------------------------------------------
// Pure functions — no DB needed
// ---------------------------------------------------------------------------

describe("fingerprintOf", () => {
  test("bounce → sessions/all/brief", () => {
    expect(fingerprintOf({ command: "bounce" })).toEqual({ half: "sessions", scope: "all", downtime: "brief" });
  });

  test("host_restart → sessions/all/brief", () => {
    expect(fingerprintOf({ command: "host_restart" })).toEqual({ half: "sessions", scope: "all", downtime: "brief" });
  });

  test("full_restart → both/all/full", () => {
    expect(fingerprintOf({ command: "full_restart" })).toEqual({ half: "both", scope: "all", downtime: "full" });
  });

  // `full`, not `brief` — corrected 2026-08-12. Nothing restarts a stopped
  // project's session until a human presses Start, which is exactly the
  // distinction CLAUDE.md warns about in this command family.
  test("proj_stop → sessions/<path>/full, from payload.path", () => {
    expect(fingerprintOf({ command: "proj_stop", payload: { path: "/home/a/proj", name: "proj" } }))
      .toEqual({ half: "sessions", scope: "/home/a/proj", downtime: "full" });
  });

  test("proj_stop falls back to name when path is absent", () => {
    expect(fingerprintOf({ command: "proj_stop", payload: { name: "proj" } }))
      .toEqual({ half: "sessions", scope: "proj", downtime: "full" });
  });

  test("proj_stop with neither returns null", () => {
    expect(fingerprintOf({ command: "proj_stop", payload: {} })).toBeNull();
  });

  // Rewritten 2026-08-12. This list used to hold six commands that are now
  // gated — it was written when the gate covered three of the eight
  // entrances, and it asserted that gap was intentional. What genuinely has
  // no fingerprint is the bring-up family and everything outside the model.
  test("bring-up commands and non-restart commands return null", () => {
    for (const command of ["tmux_start", "proj_start", "stack_up", "restart_admin_daemon", "tmux_send_keys", "supervisor_ack", "nonsense"]) {
      expect([command, fingerprintOf({ command })]).toEqual([command, null]);
    }
  });

  // AC7 — the fingerprint is re-derived from the action about to run, never
  // trusted from something that travelled alongside it. A forged
  // `payload.fingerprint` must have no effect on what fingerprintOf derives
  // for a command it does not read that field for.
  test("AC7: a fingerprint carried in the payload is ignored — bounce always derives sessions/all/brief", () => {
    const forged = {
      command: "bounce",
      payload: { fingerprint: { half: "container", scope: "all", downtime: "brief" } },
    };
    expect(fingerprintOf(forged)).toEqual({ half: "sessions", scope: "all", downtime: "brief" });
  });
});

describe("describeFingerprint / fingerprintsEqual", () => {
  test("describes as half/scope/downtime", () => {
    expect(describeFingerprint({ half: "container", scope: "all", downtime: "brief" })).toBe("container/all/brief");
  });

  test("equality is componentwise", () => {
    const a: ActionFingerprint = { half: "sessions", scope: "all", downtime: "brief" };
    const b: ActionFingerprint = { half: "sessions", scope: "all", downtime: "brief" };
    const c: ActionFingerprint = { half: "sessions", scope: "/x", downtime: "brief" };
    expect(fingerprintsEqual(a, b)).toBe(true);
    expect(fingerprintsEqual(a, c)).toBe(false);
  });
});

describe("confirmationText — AC6", () => {
  test("names the half and the scope", () => {
    expect(confirmationText({ half: "container", scope: "all", downtime: "brief" })).toContain("контейнер");
    expect(confirmationText({ half: "both", scope: "all", downtime: "full" })).toContain("контейнер");
    expect(confirmationText({ half: "both", scope: "all", downtime: "full" })).toContain("сесси");
    expect(confirmationText({ half: "sessions", scope: "all", downtime: "brief" })).toContain("все сессии");
    expect(confirmationText({ half: "sessions", scope: "/home/a/proj", downtime: "brief" })).toContain("/home/a/proj");
  });

  test("names the downtime distinctly per tier", () => {
    const none = confirmationText({ half: "sessions", scope: "all", downtime: "none" });
    const brief = confirmationText({ half: "sessions", scope: "all", downtime: "brief" });
    const full = confirmationText({ half: "sessions", scope: "all", downtime: "full" });
    expect(new Set([none, brief, full]).size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// AC12 — grant records validate against the real JSON schema
// ---------------------------------------------------------------------------

/**
 * A minimal validator for exactly this one schema — not a general JSON
 * Schema engine. `ajv`/`ajv-formats` are present in node_modules only as
 * transitive dependencies of eslint and @modelcontextprotocol/sdk, not
 * declared by this project, so depending on them directly here would be an
 * undeclared dependency the next `bun install` could quietly drop. The schema
 * itself is loaded from disk — nothing about its shape is duplicated here
 * except the handful of keywords it actually uses.
 */
function validateAgainstSchema(schema: any, value: unknown, path = "$"): string[] {
  const errors: string[] = [];
  if (schema.oneOf) {
    const matches = (schema.oneOf as any[]).filter((s: any) => validateAgainstSchema(s, value, path).length === 0);
    if (matches.length !== 1) errors.push(`${path}: matched ${matches.length} of oneOf, want exactly 1`);
    return errors;
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push(`${path}: expected object`);
      return errors;
    }
    const obj = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (!(req in obj)) errors.push(`${path}: missing required "${req}"`);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(obj)) {
        if (!(key in (schema.properties ?? {}))) errors.push(`${path}: unexpected property "${key}"`);
      }
    }
    for (const [key, propSchema] of Object.entries<any>(schema.properties ?? {})) {
      if (!(key in obj)) continue;
      errors.push(...validateAgainstSchema(propSchema, obj[key], `${path}.${key}`));
    }
    return errors;
  }
  if (schema.$ref) {
    const refName = String(schema.$ref).split("/").pop()!;
    const resolved = SCHEMA_ROOT.$defs?.[refName];
    if (!resolved) { errors.push(`${path}: unresolved $ref ${schema.$ref}`); return errors; }
    return validateAgainstSchema(resolved, value, path);
  }
  if (Array.isArray(schema.type)) {
    const ok = schema.type.some((t: string) => matchesPrimitive(t, value));
    if (!ok) errors.push(`${path}: expected one of [${schema.type.join(", ")}], got ${JSON.stringify(value)}`);
    return errors;
  }
  if (schema.type) {
    if (!matchesPrimitive(schema.type, value)) {
      errors.push(`${path}: expected ${schema.type}, got ${JSON.stringify(value)}`);
      return errors;
    }
  }
  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} not in enum [${schema.enum.join(", ")}]`);
  }
  if (schema.minLength !== undefined && typeof value === "string" && value.length < schema.minLength) {
    errors.push(`${path}: shorter than minLength ${schema.minLength}`);
  }
  return errors;
}

function matchesPrimitive(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "string") return typeof value === "string";
  if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
  return false;
}

let SCHEMA_ROOT: any;

describe("grant records validate against the real schema — AC12", () => {
  beforeAll(async () => {
    const text = await Bun.file(
      new URL(
        "../../docs/requirements/keryx-adoption-2026-08-12/schemas/action-approval-grant.schema.json",
        import.meta.url,
      ),
    ).text();
    SCHEMA_ROOT = JSON.parse(text);
  });

  test("the schema's own examples validate — proves the validator agrees with the schema author", () => {
    for (const example of SCHEMA_ROOT.examples) {
      expect([example.grantId, validateAgainstSchema(SCHEMA_ROOT, example)]).toEqual([example.grantId, []]);
    }
  });

  test("an operator grant produced by issueOperatorGrant, minus internal fields, validates", async () => {
    const shaped = toApprovalGrant({
      grantId: "g_1234567890abcdef",
      kind: "operator",
      fingerprint: { half: "container", scope: "all", downtime: "brief" },
      requestId: "req-1",
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      consumedAt: null,
      issuedBy: 100200300,
      statedTo: "Перезапустить контейнер бота.",
      pendingCommand: "docker_restart",
      pendingPayload: {},
    });
    expect(validateAgainstSchema(SCHEMA_ROOT, shaped)).toEqual([]);
  });

  test("a standing grant's issuedBy shape (actor + authorizedBy) validates", async () => {
    const shaped = toApprovalGrant({
      grantId: "g_standingwatchdoghelyx",
      kind: "standing",
      fingerprint: { half: "sessions", scope: "/home/altsay/bots/helyx", downtime: "brief" },
      requestId: null,
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      consumedAt: null,
      issuedBy: { actor: "tmux-watchdog", authorizedBy: 100200300 },
      statedTo: "tmux-watchdog may restart a wedged session of this project without asking.",
      pendingCommand: null,
      pendingPayload: {},
    });
    expect(validateAgainstSchema(SCHEMA_ROOT, shaped)).toEqual([]);
  });

  test("additionalProperties: false rejects a grant carrying the internal pending* fields", () => {
    const withInternals = {
      grantId: "g_1234567890abcdef",
      kind: "operator",
      fingerprint: { half: "container", scope: "all", downtime: "brief" },
      requestId: null,
      issuedAt: new Date().toISOString(),
      expiresAt: null,
      consumedAt: null,
      issuedBy: 1,
      pendingCommand: "docker_restart", // not part of the schema
    };
    expect(validateAgainstSchema(SCHEMA_ROOT, withInternals).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Against a real database
// ---------------------------------------------------------------------------

const availability = await databaseAvailable();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.log(`[action-approval-grant] skipped — ${NO_DATABASE_MESSAGE}`);
}

describeWithDb("presentGrant, against a real database", () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await provisionTestDatabase();
  });

  afterAll(async () => {
    await db?.drop();
  });

  const FP_CONTAINER: ActionFingerprint = { half: "container", scope: "all", downtime: "brief" };
  const FP_SESSIONS: ActionFingerprint = { half: "sessions", scope: "all", downtime: "brief" };

  test("AC6: statedTo is persisted verbatim as what was shown", async () => {
    const text = confirmationText(FP_CONTAINER);
    const grant = await issueOperatorGrant(db.sql, {
      fingerprint: FP_CONTAINER, issuedBy: 1, pendingCommand: "full_restart", statedTo: text,
    });
    const read = await getGrant(db.sql, grant.grantId);
    expect(read?.statedTo).toBe(text);
  });

  test("AC1: a grant issued for container/all/brief is refused when presented for sessions/all/brief, naming both", async () => {
    const grant = await issueOperatorGrant(db.sql, { fingerprint: FP_CONTAINER, issuedBy: 1, pendingCommand: "x" });
    const result = await presentGrant(db.sql, grant.grantId, FP_SESSIONS);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("mismatch");
    if (result.reason !== "mismatch") throw new Error("unreachable");
    expect(result.grantedFingerprint).toEqual(FP_CONTAINER);
    expect(result.actionFingerprint).toEqual(FP_SESSIONS);
  });

  test("AC2: an operator grant is single-use — the second presentation is refused with a distinct reason from AC1", async () => {
    const grant = await issueOperatorGrant(db.sql, { fingerprint: FP_SESSIONS, issuedBy: 1, pendingCommand: "bounce" });
    const first = await presentGrant(db.sql, grant.grantId, FP_SESSIONS);
    expect(first.ok).toBe(true);

    const second = await presentGrant(db.sql, grant.grantId, FP_SESSIONS);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.reason).toBe("consumed");
    expect(second.reason).not.toBe("mismatch");
  });

  test("AC2 is race-safe: two concurrent presentations of the same grant, only one succeeds", async () => {
    const grant = await issueOperatorGrant(db.sql, { fingerprint: FP_SESSIONS, issuedBy: 1, pendingCommand: "bounce" });
    const [a, b] = await Promise.all([
      presentGrant(db.sql, grant.grantId, FP_SESSIONS),
      presentGrant(db.sql, grant.grantId, FP_SESSIONS),
    ]);
    const oks = [a, b].filter((r) => r.ok);
    expect(oks.length).toBe(1);
  });

  test("AC3: a grant presented after its expiresAt is refused", async () => {
    const now = new Date();
    const grant = await issueOperatorGrant(db.sql, {
      fingerprint: FP_SESSIONS, issuedBy: 1, pendingCommand: "bounce",
      now, ttlMs: 1000,
    });
    const later = new Date(now.getTime() + 5000);
    const result = await presentGrant(db.sql, grant.grantId, FP_SESSIONS, later);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("expired");
  });

  test("presenting an unknown grant id is refused as not-found", async () => {
    const result = await presentGrant(db.sql, "g_doesnotexist00000000", FP_SESSIONS);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("not-found");
  });

  test("cancelGrant spends an unconfirmed grant without it ever authorizing anything", async () => {
    const grant = await issueOperatorGrant(db.sql, { fingerprint: FP_SESSIONS, issuedBy: 1, pendingCommand: "bounce" });
    await cancelGrant(db.sql, grant.grantId);
    const result = await presentGrant(db.sql, grant.grantId, FP_SESSIONS);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("consumed");
  });

  test("AC10: a standing grant is not consumed by use — two successive uses both succeed", async () => {
    const fp: ActionFingerprint = { half: "sessions", scope: "/tmp/some-project", downtime: "brief" };
    await issueStandingGrant(db.sql, { fingerprint: fp, actor: "tmux-watchdog", authorizedBy: 1 });

    const first = await authorizeAutonomousAction(db.sql, "tmux-watchdog", fp);
    const second = await authorizeAutonomousAction(db.sql, "tmux-watchdog", fp);
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
  });

  test("AC10 (other half): an operator grant's second use fails, unlike the standing grant above", async () => {
    const grant = await issueOperatorGrant(db.sql, { fingerprint: FP_SESSIONS, issuedBy: 1, pendingCommand: "bounce" });
    expect((await presentGrant(db.sql, grant.grantId, FP_SESSIONS)).ok).toBe(true);
    expect((await presentGrant(db.sql, grant.grantId, FP_SESSIONS)).ok).toBe(false);
  });

  test("re-issuing a standing grant for the same actor+fingerprint replaces it rather than duplicating", async () => {
    const fp: ActionFingerprint = { half: "sessions", scope: "/tmp/replace-me", downtime: "brief" };
    const a = await issueStandingGrant(db.sql, { fingerprint: fp, actor: "tmux-watchdog", authorizedBy: 1 });
    const b = await issueStandingGrant(db.sql, { fingerprint: fp, actor: "tmux-watchdog", authorizedBy: 2 });
    expect(a.grantId).not.toBe(b.grantId);

    const rows = await db.sql`
      SELECT count(*)::int AS n FROM action_approval_grants
      WHERE issued_by_actor = 'tmux-watchdog' AND scope = ${fp.scope}
    `;
    expect(Number(rows[0]!.n)).toBe(1);
  });
});
