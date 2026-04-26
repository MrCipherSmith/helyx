/**
 * Integration tests for runtime/state-recovery.ts startup sweeps.
 *
 * Validates the recovery contract: a daemon crashing mid-transition leaves
 * agent_instances rows in transient states (`starting`, `stopping`,
 * `waiting_approval`) that no actor in the system updates again. The
 * sweeps run at admin-daemon startup must reset only those rows that
 * are *actually* orphaned, never touching the current daemon's
 * in-flight transitions (bounded by the 60s staleness window).
 *
 * Requires DATABASE_URL. Skipped when unset.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const RUN_TAG = `state-recovery-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function getCtx() {
  const { sql } = await import("../../memory/db.ts");
  const recov = await import("../../runtime/state-recovery.ts");
  return { sql, recov };
}

interface SeedRow {
  defId: number;
  // Each test creates its own instances — defId is shared.
  cleanupInstanceIds: number[];
}

let seed: SeedRow | null = null;

beforeAll(async () => {
  if (!HAS_DB) return;
  const { sql } = await getCtx();
  const [def] = (await sql`
    INSERT INTO agent_definitions (name, description, runtime_type, runtime_driver, capabilities, enabled)
    VALUES (
      ${`def-${RUN_TAG}`},
      'integration test definition for state-recovery',
      'standalone-llm',
      'standalone',
      '[]'::jsonb,
      true
    )
    RETURNING id
  `) as any[];
  seed = { defId: Number(def.id), cleanupInstanceIds: [] };
});

afterAll(async () => {
  if (!HAS_DB || !seed) return;
  const { sql } = await getCtx();
  if (seed.cleanupInstanceIds.length > 0) {
    await sql`DELETE FROM agent_events WHERE agent_instance_id IN ${sql(seed.cleanupInstanceIds)}`;
    await sql`DELETE FROM agent_instances WHERE id IN ${sql(seed.cleanupInstanceIds)}`;
  }
  await sql`DELETE FROM agent_definitions WHERE id = ${seed.defId}`;
});

async function makeInstance(
  name: string,
  actualState: "starting" | "stopping" | "waiting_approval" | "running" | "new",
  lastHealthAt: Date | null,
): Promise<number> {
  const { sql } = await getCtx();
  const [row] = (await sql`
    INSERT INTO agent_instances
      (definition_id, project_id, name, desired_state, actual_state, last_health_at)
    VALUES (
      ${seed!.defId},
      NULL,
      ${name},
      'running',
      ${actualState},
      ${lastHealthAt}
    )
    RETURNING id
  `) as any[];
  const id = Number(row.id);
  seed!.cleanupInstanceIds.push(id);
  return id;
}

async function getActualState(id: number): Promise<string> {
  const { sql } = await getCtx();
  const [row] = (await sql`SELECT actual_state FROM agent_instances WHERE id = ${id}`) as any[];
  return row.actual_state;
}

describe("state-recovery: sweepStaleTransientStates", () => {
  test.skipIf(!HAS_DB)("resets stale 'starting' to 'stopped'", async () => {
    const { recov, sql } = await getCtx();
    const longAgo = new Date(Date.now() - 5 * 60_000); // 5 min stale
    const id = await makeInstance(`stale-starting-${RUN_TAG}`, "starting", longAgo);

    const swept = await recov.sweepStaleTransientStates(sql);

    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await getActualState(id)).toBe("stopped");
  });

  test.skipIf(!HAS_DB)("resets stale 'stopping' to 'stopped'", async () => {
    const { recov, sql } = await getCtx();
    const longAgo = new Date(Date.now() - 5 * 60_000);
    const id = await makeInstance(`stale-stopping-${RUN_TAG}`, "stopping", longAgo);

    await recov.sweepStaleTransientStates(sql);

    expect(await getActualState(id)).toBe("stopped");
  });

  test.skipIf(!HAS_DB)("resets 'starting' with NULL last_health_at (never observed)", async () => {
    const { recov, sql } = await getCtx();
    const id = await makeInstance(`null-health-${RUN_TAG}`, "starting", null);

    await recov.sweepStaleTransientStates(sql);

    expect(await getActualState(id)).toBe("stopped");
  });

  test.skipIf(!HAS_DB)("does NOT touch fresh 'starting' inside the staleness window", async () => {
    const { recov, sql } = await getCtx();
    // 10s old — well within the 60s window.
    const fresh = new Date(Date.now() - 10_000);
    const id = await makeInstance(`fresh-starting-${RUN_TAG}`, "starting", fresh);

    await recov.sweepStaleTransientStates(sql);

    expect(await getActualState(id)).toBe("starting");
  });

  test.skipIf(!HAS_DB)("does NOT touch 'running' instances regardless of staleness", async () => {
    const { recov, sql } = await getCtx();
    const longAgo = new Date(Date.now() - 5 * 60_000);
    const id = await makeInstance(`running-untouched-${RUN_TAG}`, "running", longAgo);

    await recov.sweepStaleTransientStates(sql);

    expect(await getActualState(id)).toBe("running");
  });

  test.skipIf(!HAS_DB)("custom staleSeconds threshold respected", async () => {
    const { recov, sql } = await getCtx();
    // 30s old: stale under threshold=10, fresh under threshold=60.
    const thirtyAgo = new Date(Date.now() - 30_000);
    const id = await makeInstance(`custom-threshold-${RUN_TAG}`, "starting", thirtyAgo);

    // First call: 60s threshold (default) leaves the row alone.
    await recov.sweepStaleTransientStates(sql, 60);
    expect(await getActualState(id)).toBe("starting");

    // Second call: 10s threshold sweeps it.
    await recov.sweepStaleTransientStates(sql, 10);
    expect(await getActualState(id)).toBe("stopped");
  });
});

describe("state-recovery: sweepOrphanedWaitingApproval", () => {
  test.skipIf(!HAS_DB)("flips 'waiting_approval' to 'running' regardless of staleness", async () => {
    const { recov, sql } = await getCtx();
    // Fresh timestamp on purpose — the contract says no staleness bound.
    const fresh = new Date(Date.now() - 5_000);
    const id = await makeInstance(`approval-${RUN_TAG}`, "waiting_approval", fresh);

    const swept = await recov.sweepOrphanedWaitingApproval(sql);

    expect(swept).toBeGreaterThanOrEqual(1);
    expect(await getActualState(id)).toBe("running");
  });

  test.skipIf(!HAS_DB)("ignores rows in other states", async () => {
    const { recov, sql } = await getCtx();
    const id = await makeInstance(`approval-skip-${RUN_TAG}`, "running", new Date());

    await recov.sweepOrphanedWaitingApproval(sql);

    expect(await getActualState(id)).toBe("running");
  });
});

describe("state-recovery: runStartupSweeps", () => {
  test.skipIf(!HAS_DB)("returns counts for both sweeps and flips both rows", async () => {
    const { recov, sql } = await getCtx();
    const longAgo = new Date(Date.now() - 5 * 60_000);
    const transientId = await makeInstance(`combined-transient-${RUN_TAG}`, "starting", longAgo);
    const approvalId = await makeInstance(`combined-approval-${RUN_TAG}`, "waiting_approval", new Date());

    const result = await recov.runStartupSweeps(sql);

    expect(result.staleTransient).toBeGreaterThanOrEqual(1);
    expect(result.orphanedApproval).toBeGreaterThanOrEqual(1);
    expect(await getActualState(transientId)).toBe("stopped");
    expect(await getActualState(approvalId)).toBe("running");
  });

  test.skipIf(!HAS_DB)("does NOT throw when called twice in a row (idempotent)", async () => {
    const { recov, sql } = await getCtx();
    const longAgo = new Date(Date.now() - 5 * 60_000);
    await makeInstance(`idempotent-${RUN_TAG}`, "starting", longAgo);

    const first = await recov.runStartupSweeps(sql);
    const second = await recov.runStartupSweeps(sql);

    // Second call sees no eligible rows → counts may be 0.
    expect(first.staleTransient + first.orphanedApproval).toBeGreaterThanOrEqual(1);
    expect(second.staleTransient).toBe(0);
  });
});
