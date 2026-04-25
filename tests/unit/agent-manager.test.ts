/**
 * Unit tests for `AgentManager` — contract / type-level / public API surface.
 *
 * AgentManager talks to Postgres via the `sql` template tag, so most of its
 * methods are integration-level. Bun's test runner doesn't ship a fixture
 * harness for transactional DB tests, so we deliberately scope these tests to:
 *   - DesiredState / ActualState union shapes
 *   - AgentInstance / AgentDefinition object shapes
 *   - The `agentManager` singleton's public method surface
 *
 * DB-touching behaviour (createInstance, setDesiredState, setActualState
 * transactions, event logging) is exercised end-to-end by the reconcile loop
 * tests in `reconcile-loop.test.ts` (with mocks) and by manual smoke tests in
 * the admin-daemon flow.
 */
import { describe, test, expect } from "bun:test";
import type {
  AgentInstance,
  AgentDefinition,
  DesiredState,
  ActualState,
} from "../../agents/agent-manager.ts";

describe("agent-manager: types", () => {
  test("DesiredState accepts running, stopped, paused", () => {
    const valid: DesiredState[] = ["running", "stopped", "paused"];
    expect(valid).toHaveLength(3);
    expect(valid).toContain("running");
    expect(valid).toContain("stopped");
    expect(valid).toContain("paused");
  });

  test("ActualState accepts the 10 documented states", () => {
    const valid: ActualState[] = [
      "new",
      "starting",
      "running",
      "idle",
      "busy",
      "waiting_approval",
      "stuck",
      "stopping",
      "stopped",
      "failed",
    ];
    expect(valid).toHaveLength(10);
  });

  test("AgentInstance shape — minimal required fields compile and round-trip", () => {
    const stub: AgentInstance = {
      id: 1,
      definitionId: 1,
      projectId: null,
      name: "test",
      desiredState: "stopped",
      actualState: "new",
      runtimeHandle: {},
      lastSnapshot: null,
      lastSnapshotAt: null,
      lastHealthAt: null,
      restartCount: 0,
      lastRestartAt: null,
      sessionId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(stub.id).toBe(1);
    expect(stub.desiredState).toBe("stopped");
    expect(stub.actualState).toBe("new");
    expect(stub.restartCount).toBe(0);
    expect(stub.runtimeHandle).toEqual({});
  });

  test("AgentInstance accepts populated runtime_handle JSONB", () => {
    const stub: AgentInstance = {
      id: 2,
      definitionId: 1,
      projectId: 7,
      name: "with-handle",
      desiredState: "running",
      actualState: "running",
      runtimeHandle: {
        driver: "tmux",
        tmuxSession: "bots",
        tmuxWindow: "myproj",
        projectPath: "/home/x/proj",
        projectName: "myproj",
      },
      lastSnapshot: "some output\nmore output",
      lastSnapshotAt: new Date(),
      lastHealthAt: new Date(),
      restartCount: 2,
      lastRestartAt: new Date(),
      sessionId: 42,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(stub.runtimeHandle.driver).toBe("tmux");
    expect(stub.sessionId).toBe(42);
    expect(stub.restartCount).toBe(2);
  });

  test("AgentDefinition shape — capabilities is array, config is record", () => {
    const def: AgentDefinition = {
      id: 1,
      name: "default",
      description: null,
      runtimeType: "claude-code",
      runtimeDriver: "tmux",
      modelProfileId: null,
      systemPrompt: null,
      capabilities: ["code", "review"],
      config: {},
      enabled: true,
    };
    expect(def.capabilities).toContain("code");
    expect(def.capabilities).toContain("review");
    expect(def.enabled).toBe(true);
    expect(def.runtimeDriver).toBe("tmux");
  });

  test("AgentDefinition accepts populated systemPrompt and config", () => {
    const def: AgentDefinition = {
      id: 2,
      name: "reviewer",
      description: "Code reviewer profile",
      runtimeType: "claude-code",
      runtimeDriver: "tmux",
      modelProfileId: 5,
      systemPrompt: "You are a strict code reviewer.",
      capabilities: ["review", "comment"],
      config: { maxTokens: 4096, temperature: 0.2 },
      enabled: true,
    };
    expect(def.modelProfileId).toBe(5);
    expect(def.config.maxTokens).toBe(4096);
    expect(def.systemPrompt).toContain("reviewer");
  });
});

describe("agent-manager: agentManager singleton", () => {
  test("module export shape — singleton + class exist", async () => {
    const mod = await import("../../agents/agent-manager.ts");
    expect(mod.agentManager).toBeDefined();
    expect(mod.AgentManager).toBeDefined();
    // singleton should be an instance of the class
    expect(mod.agentManager instanceof mod.AgentManager).toBe(true);
  });

  test("public method surface — instance methods", async () => {
    const { agentManager } = await import("../../agents/agent-manager.ts");
    expect(typeof agentManager.listInstances).toBe("function");
    expect(typeof agentManager.getInstance).toBe("function");
    expect(typeof agentManager.getInstanceByName).toBe("function");
    expect(typeof agentManager.createInstance).toBe("function");
    expect(typeof agentManager.setDesiredState).toBe("function");
    expect(typeof agentManager.setActualState).toBe("function");
    expect(typeof agentManager.incrementRestartCount).toBe("function");
    expect(typeof agentManager.updateRuntimeHandle).toBe("function");
    expect(typeof agentManager.updateSnapshot).toBe("function");
    expect(typeof agentManager.linkSession).toBe("function");
  });

  test("public method surface — definition methods", async () => {
    const { agentManager } = await import("../../agents/agent-manager.ts");
    expect(typeof agentManager.listDefinitions).toBe("function");
    expect(typeof agentManager.getDefinition).toBe("function");
    expect(typeof agentManager.getDefinitionByName).toBe("function");
  });

  test("public method surface — events", async () => {
    const { agentManager } = await import("../../agents/agent-manager.ts");
    expect(typeof agentManager.logEvent).toBe("function");
  });
});
