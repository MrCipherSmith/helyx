/**
 * Integration tests — systemic jsonb cast fix (v1.37.0).
 *
 * Regression guard for the `${JSON.stringify(x)}::jsonb` bug fixed across
 * ~14 call sites. postgres.js v3 silently strips trailing `::jsonb` casts
 * on parameter placeholders, binding the value as TEXT — postgres then
 * stores it as a JSONB **scalar string** (not a parsed object). All
 * production sites were migrated to `${sql.json(x)}` / `${tx.json(x)}`.
 *
 * Each test exercises a real write path and asserts
 * `jsonb_typeof = 'object'` on the persisted row. Reverting any patched
 * site to the old form fails the corresponding test.
 *
 * Requires DATABASE_URL.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

const HAS_DB = Boolean(process.env.DATABASE_URL);

const RUN_TAG = `jsonb-cast-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function getCtx() {
  const { sql } = await import("../../memory/db.ts");
  const orch = await import("../../agents/orchestrator.ts");
  const mgr = await import("../../agents/agent-manager.ts");
  return { sql, orch, mgr };
}

interface SeedRow {
  defId: number;
  agentId: number;
  cleanupTaskIds: number[];
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
      'integration test definition for jsonb-cast-systemic',
      'standalone-llm',
      'standalone',
      '[]'::jsonb,
      true
    )
    RETURNING id
  `) as any[];
  const [agent] = (await sql`
    INSERT INTO agent_instances (definition_id, project_id, name, desired_state, actual_state)
    VALUES (${Number(def.id)}, NULL, ${`agent-${RUN_TAG}`}, 'running', 'running')
    RETURNING id
  `) as any[];
  seed = {
    defId: Number(def.id),
    agentId: Number(agent.id),
    cleanupTaskIds: [],
    cleanupInstanceIds: [Number(agent.id)],
  };
});

afterAll(async () => {
  if (!HAS_DB || !seed) return;
  const { sql } = await getCtx();
  if (seed.cleanupTaskIds.length > 0) {
    await sql`DELETE FROM agent_events WHERE task_id IN ${sql(seed.cleanupTaskIds)}`;
    await sql`DELETE FROM agent_tasks WHERE id IN ${sql(seed.cleanupTaskIds)}`;
  }
  await sql`DELETE FROM agent_events WHERE agent_instance_id IN ${sql(seed.cleanupInstanceIds)}`;
  await sql`DELETE FROM agent_instances WHERE id IN ${sql(seed.cleanupInstanceIds)}`;
  await sql`DELETE FROM agent_definitions WHERE id = ${seed.defId}`;
});

async function jsonbType(table: string, column: string, id: number): Promise<string> {
  const { sql } = await getCtx();
  const rows = (await (sql as any).unsafe(
    `SELECT jsonb_typeof(${column}) AS t FROM ${table} WHERE id = $1`,
    [id],
  )) as any[];
  return rows[0]?.t;
}

describe("jsonb-cast-systemic — orchestrator.createTask.payload", () => {
  test.skipIf(!HAS_DB)("payload stored as JSONB object (not scalar string)", async () => {
    const { orch } = await getCtx();
    const task = await orch.orchestrator.createTask({
      title: `task-payload-${RUN_TAG}`,
      payload: { foo: "bar", nested: { a: 1, b: [2, 3] } },
      agentInstanceId: seed!.agentId,
    });
    seed!.cleanupTaskIds.push(task.id);

    expect(await jsonbType("agent_tasks", "payload", task.id)).toBe("object");
    // Round-trip the payload — must be a real object, not a string.
    const fetched = await orch.orchestrator.getTask(task.id);
    expect(fetched).not.toBeNull();
    expect(typeof fetched!.payload).toBe("object");
    expect((fetched!.payload as any).foo).toBe("bar");
    expect((fetched!.payload as any).nested.b).toEqual([2, 3]);
  });

  test.skipIf(!HAS_DB)("empty payload still object, not string", async () => {
    const { orch } = await getCtx();
    const task = await orch.orchestrator.createTask({
      title: `empty-payload-${RUN_TAG}`,
      agentInstanceId: seed!.agentId,
    });
    seed!.cleanupTaskIds.push(task.id);
    expect(await jsonbType("agent_tasks", "payload", task.id)).toBe("object");
  });
});

describe("jsonb-cast-systemic — orchestrator.setResult", () => {
  test.skipIf(!HAS_DB)("result stored as JSONB object", async () => {
    const { orch } = await getCtx();
    const task = await orch.orchestrator.createTask({
      title: `task-result-${RUN_TAG}`,
      agentInstanceId: seed!.agentId,
    });
    seed!.cleanupTaskIds.push(task.id);

    await orch.orchestrator.setResult(task.id, {
      output: "hello",
      tokens: 42,
    });

    expect(await jsonbType("agent_tasks", "result", task.id)).toBe("object");
    const fetched = await orch.orchestrator.getTask(task.id);
    expect((fetched!.result as any).output).toBe("hello");
    expect((fetched!.result as any).tokens).toBe(42);
  });
});

describe("jsonb-cast-systemic — agentManager.logEvent.metadata", () => {
  test.skipIf(!HAS_DB)("event metadata stored as JSONB object", async () => {
    const { sql, mgr } = await getCtx();
    await mgr.agentManager.logEvent({
      agentInstanceId: seed!.agentId,
      eventType: "test_event",
      metadata: { kind: "regression", fields: ["a", "b"] },
    });

    const rows = (await sql`
      SELECT id, jsonb_typeof(metadata) AS t, metadata
      FROM agent_events
      WHERE agent_instance_id = ${seed!.agentId} AND event_type = 'test_event'
      ORDER BY id DESC LIMIT 1
    `) as any[];
    expect(rows[0].t).toBe("object");
    expect(rows[0].metadata.kind).toBe("regression");
  });
});

describe("jsonb-cast-systemic — agentManager.createInstance + updateRuntimeHandle", () => {
  test.skipIf(!HAS_DB)("createInstance runtime_handle stored as object", async () => {
    const { sql, mgr } = await getCtx();
    const inst = await mgr.agentManager.createInstance({
      definitionId: seed!.defId,
      projectId: null,
      name: `inst-create-${RUN_TAG}`,
      runtimeHandle: { driver: "tmux", tmuxSession: "bots", tmuxWindow: "x" },
      desiredState: "running",
    });
    seed!.cleanupInstanceIds.push(inst.id);

    const rows = (await sql`
      SELECT jsonb_typeof(runtime_handle) AS t, runtime_handle
      FROM agent_instances WHERE id = ${inst.id}
    `) as any[];
    expect(rows[0].t).toBe("object");
    expect(rows[0].runtime_handle.tmuxWindow).toBe("x");
  });

  test.skipIf(!HAS_DB)("updateRuntimeHandle preserves object shape (no scalar-string regression)", async () => {
    const { sql, mgr } = await getCtx();
    const inst = await mgr.agentManager.createInstance({
      definitionId: seed!.defId,
      projectId: null,
      name: `inst-update-${RUN_TAG}`,
      runtimeHandle: {},
      desiredState: "running",
    });
    seed!.cleanupInstanceIds.push(inst.id);

    // Two consecutive updates — the bloat bug manifests on the second write
    // because the first read-back returns a string that gets spread into a
    // char-map object. With the fix, updateRuntimeHandle never produces a
    // scalar string, so reads return a real object and spreads stay clean.
    await mgr.agentManager.updateRuntimeHandle(inst.id, {
      driver: "tmux",
      tmuxSession: "bots",
      tmuxWindow: "first",
    });
    const rows1 = (await sql`SELECT runtime_handle FROM agent_instances WHERE id = ${inst.id}`) as any[];
    // Spread the read-back value as the reconciler does. With the fix this
    // is safe; without it, this spread produces a char-map and the bloat
    // begins.
    const handle = { ...(rows1[0].runtime_handle as any) };
    expect(handle.tmuxWindow).toBe("first");
    expect(typeof handle.tmuxWindow).toBe("string");
    expect(handle["0"]).toBeUndefined(); // char-map signature MUST be absent

    await mgr.agentManager.updateRuntimeHandle(inst.id, { ...handle, tmuxWindow: "second" });
    const rows2 = (await sql`
      SELECT jsonb_typeof(runtime_handle) AS t, length(runtime_handle::text) AS sz, runtime_handle
      FROM agent_instances WHERE id = ${inst.id}
    `) as any[];
    expect(rows2[0].t).toBe("object");
    expect(rows2[0].runtime_handle.tmuxWindow).toBe("second");
    // Tight upper bound — sane handle is well under 200 bytes; bloat would
    // already be in the kilobytes after one corrupted spread cycle.
    expect(rows2[0].sz).toBeLessThan(200);
  });
});

describe("jsonb-cast-systemic — handleFailure event metadata", () => {
  test.skipIf(!HAS_DB)("task_reassigned event metadata stored as object", async () => {
    const { sql, orch } = await getCtx();
    // Seed a second agent under the same definition so handleFailure can reassign.
    const [agent2Row] = (await sql`
      INSERT INTO agent_instances (definition_id, project_id, name, desired_state, actual_state)
      VALUES (${seed!.defId}, NULL, ${`agent2-${RUN_TAG}`}, 'running', 'running')
      RETURNING id
    `) as any[];
    const agent2Id = Number(agent2Row.id);
    seed!.cleanupInstanceIds.push(agent2Id);

    // Definition needs an explicit capability for handleFailure to find a candidate.
    await sql`UPDATE agent_definitions SET capabilities = ${sql.json(["test:reassign"])} WHERE id = ${seed!.defId}`;

    const task = await orch.orchestrator.createTask({
      title: `reassign-task-${RUN_TAG}`,
      payload: { required_capabilities: ["test:reassign"] },
      agentInstanceId: seed!.agentId,
    });
    seed!.cleanupTaskIds.push(task.id);

    await orch.orchestrator.handleFailure(task.id, { reason: "regression-test" });

    const rows = (await sql`
      SELECT jsonb_typeof(metadata) AS t, metadata
      FROM agent_events
      WHERE task_id = ${task.id} AND event_type = 'task_reassigned'
      ORDER BY id DESC LIMIT 1
    `) as any[];
    expect(rows[0].t).toBe("object");
    expect((rows[0].metadata as any).previous_agent_id).toBe(seed!.agentId);
  });
});

describe("jsonb-cast-systemic — payload round-trip drives behavior", () => {
  test.skipIf(!HAS_DB)("task.payload.required_capabilities reachable from JS side", async () => {
    const { orch } = await getCtx();
    // The payload-fallback path in handleFailure reads
    // task.payload.required_capabilities. Under the broken cast, payload
    // round-trips as a string and `.required_capabilities` is undefined —
    // the fallback path silently fails. This test proves the round-trip.
    const task = await orch.orchestrator.createTask({
      title: `roundtrip-${RUN_TAG}`,
      payload: { required_capabilities: ["a", "b"], foo: 42 },
      agentInstanceId: seed!.agentId,
    });
    seed!.cleanupTaskIds.push(task.id);

    const fetched = await orch.orchestrator.getTask(task.id);
    expect(fetched).not.toBeNull();
    // .required_capabilities must be a real array, not undefined and not
    // index-accessing characters of a stringified object.
    expect(Array.isArray((fetched!.payload as any).required_capabilities)).toBe(true);
    expect((fetched!.payload as any).required_capabilities).toEqual(["a", "b"]);
    expect((fetched!.payload as any).foo).toBe(42);
  });
});
