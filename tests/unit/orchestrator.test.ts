import { describe, test, expect } from "bun:test";
import type {
  TaskStatus,
  AgentTask,
  CreateTaskInput,
  TaskNode,
  HandleFailureOptions,
  HandleFailureResult,
} from "../../agents/orchestrator.ts";

describe("orchestrator: types", () => {
  test("TaskStatus accepts the 7 documented states", () => {
    const valid: TaskStatus[] = [
      "pending", "in_progress", "blocked", "review", "done", "cancelled", "failed",
    ];
    expect(valid).toHaveLength(7);
  });

  test("AgentTask shape — minimal required fields", () => {
    const stub: AgentTask = {
      id: 1,
      agentInstanceId: null,
      parentTaskId: null,
      title: "test",
      description: null,
      status: "pending",
      payload: {},
      result: null,
      priority: 0,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
    };
    expect(stub.id).toBe(1);
    expect(stub.status).toBe("pending");
  });

  test("CreateTaskInput accepts optional fields", () => {
    const minimal: CreateTaskInput = { title: "minimal" };
    expect(minimal.title).toBe("minimal");

    const full: CreateTaskInput = {
      title: "full",
      description: "desc",
      agentInstanceId: 5,
      parentTaskId: 1,
      payload: { foo: "bar" },
      priority: 10,
      requiredCapabilities: ["code", "review"],
    };
    expect(full.requiredCapabilities).toEqual(["code", "review"]);
  });

  test("TaskNode extends AgentTask with children array", () => {
    const node: TaskNode = {
      id: 1,
      agentInstanceId: null,
      parentTaskId: null,
      title: "root",
      description: null,
      status: "pending",
      payload: {},
      result: null,
      priority: 0,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      updatedAt: new Date(),
      children: [],
    };
    expect(node.children).toEqual([]);
  });
});

describe("orchestrator: singleton public API", () => {
  test("import does not throw and exports orchestrator", async () => {
    const mod = await import("../../agents/orchestrator.ts");
    expect(mod.orchestrator).toBeDefined();
    expect(typeof mod.orchestrator.createTask).toBe("function");
    expect(typeof mod.orchestrator.getTask).toBe("function");
    expect(typeof mod.orchestrator.listTasks).toBe("function");
    expect(typeof mod.orchestrator.getTaskTree).toBe("function");
    expect(typeof mod.orchestrator.setStatus).toBe("function");
    expect(typeof mod.orchestrator.assignTask).toBe("function");
    expect(typeof mod.orchestrator.setResult).toBe("function");
    expect(typeof mod.orchestrator.addSubtasks).toBe("function");
    expect(typeof mod.orchestrator.selectAgent).toBe("function");
  });

  test("Orchestrator class is exported", async () => {
    const mod = await import("../../agents/orchestrator.ts");
    expect(typeof mod.Orchestrator).toBe("function");
    const fresh = new mod.Orchestrator();
    expect(typeof fresh.createTask).toBe("function");
  });
});

describe("orchestrator: selectAgent contract", () => {
  test("returns null when required capabilities is empty array", async () => {
    const mod = await import("../../agents/orchestrator.ts");
    const result = await mod.orchestrator.selectAgent([]);
    expect(result).toBeNull();
  });

  test("returns null when no agent matches required capabilities", async () => {
    const mod = await import("../../agents/orchestrator.ts");
    // Use an obviously non-existent capability
    const result = await mod.orchestrator.selectAgent(["nonexistent-capability-xyz-9999"]);
    expect(result).toBeNull();
  });
});

describe("orchestrator: getTaskTree contract", () => {
  test("returns null for non-existent task id", async () => {
    const mod = await import("../../agents/orchestrator.ts");
    const tree = await mod.orchestrator.getTaskTree(999999999);
    expect(tree).toBeNull();
  });

  test("getTask returns null for non-existent id", async () => {
    const mod = await import("../../agents/orchestrator.ts");
    const t = await mod.orchestrator.getTask(999999999);
    expect(t).toBeNull();
  });
});

describe("orchestrator: setStatus contract", () => {
  test("throws when task id is not found", async () => {
    const mod = await import("../../agents/orchestrator.ts");
    await expect(mod.orchestrator.setStatus(999999999, "done")).rejects.toThrow(/not found/);
  });
});

describe("orchestrator: setResult contract", () => {
  test("throws when task id is not found", async () => {
    const mod = await import("../../agents/orchestrator.ts");
    await expect(mod.orchestrator.setResult(999999999, { ok: true })).rejects.toThrow(/not found/);
  });
});

describe("orchestrator: handleFailure contract", () => {
  test("HandleFailureOptions accepts all expected fields", () => {
    const opts: HandleFailureOptions = {
      maxReassignments: 3,
      excludeAgentIds: [1, 2, 3],
      reason: "test",
    };
    expect(opts.maxReassignments).toBe(3);
  });

  test("HandleFailureOptions all fields optional", () => {
    const opts: HandleFailureOptions = {};
    expect(opts).toEqual({});
  });

  test("HandleFailureResult shape", () => {
    const stub: HandleFailureResult = {
      task: {
        id: 1,
        agentInstanceId: null,
        parentTaskId: null,
        title: "x",
        description: null,
        status: "failed",
        payload: {},
        result: null,
        priority: 0,
        createdAt: new Date(),
        startedAt: null,
        completedAt: null,
        updatedAt: new Date(),
      },
      outcome: "no_alternative",
      newAgentInstanceId: null,
      attempts: 0,
    };
    expect(stub.outcome).toBe("no_alternative");
    expect(stub.newAgentInstanceId).toBeNull();
  });

  test("orchestrator.handleFailure is a function", async () => {
    const mod = await import("../../agents/orchestrator.ts");
    expect(typeof mod.orchestrator.handleFailure).toBe("function");
  });

  // DB-touching test guarded by env (consistent with decompose-task.test.ts pattern)
  const HAS_DB = Boolean(process.env.DATABASE_URL);
  test.skipIf(!HAS_DB)("handleFailure rejects when task not found (requires DB)", async () => {
    const mod = await import("../../agents/orchestrator.ts");
    await expect(mod.orchestrator.handleFailure(999999999)).rejects.toThrow(/not found/);
  });
});
