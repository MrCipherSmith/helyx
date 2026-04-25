/**
 * Unit tests for `RuntimeManager.reconcileInstance` — the core reconciliation
 * step that converges agent_instance.actual_state to desired_state.
 *
 * Strategy:
 *   - Inject a fully mocked `RuntimeDriver` (start/stop/health/snapshot/sendInput).
 *   - Inject a fully mocked `AgentManager` (every method returns a Promise stub).
 *   - Call `reconcileInstance` directly via a `(mgr as any)` cast so we can
 *     observe single-tick behaviour without setInterval timing flakiness.
 *
 * The cast is deliberate: `reconcileInstance` is private to keep the public
 * surface small, but for unit testing the reconciliation rules we want
 * deterministic single-step assertions, not a `setInterval`-driven race.
 *
 * `startReconcileLoop` itself is exercised indirectly via the no-op return
 * path test at the bottom of this file.
 */
import { describe, test, expect, mock } from "bun:test";
import { RuntimeManager } from "../../runtime/runtime-manager.ts";
import type { RuntimeDriver, RuntimeHandle } from "../../runtime/types.ts";
import type { AgentInstance } from "../../agents/agent-manager.ts";

// ---------- Mock helpers ----------

function makeMockDriver(overrides?: Partial<RuntimeDriver>): RuntimeDriver {
  return {
    name: "tmux",
    start: mock(async (h: RuntimeHandle) => h),
    stop: mock(async () => {}),
    sendInput: mock(async () => {}),
    health: mock(async () => ({
      state: "running" as const,
      lastChecked: new Date(),
    })),
    snapshot: mock(async (h: RuntimeHandle) => ({
      lines: [],
      capturedAt: new Date(),
      handle: h,
    })),
    ...overrides,
  };
}

function makeMockAgentMgr() {
  return {
    listInstances: mock(async () => [] as AgentInstance[]),
    setActualState: mock(async () => {}),
    setDesiredState: mock(async () => makeInstance()),
    updateRuntimeHandle: mock(async () => {}),
    incrementRestartCount: mock(async () => {}),
    logEvent: mock(async () => {}),
    updateSnapshot: mock(async () => {}),
    linkSession: mock(async () => {}),
    getInstance: mock(async () => null),
    getInstanceByName: mock(async () => null),
    listDefinitions: mock(async () => []),
    getDefinition: mock(async () => null),
    getDefinitionByName: mock(async () => null),
    createInstance: mock(async () => makeInstance()),
  } as any;
}

function makeInstance(overrides: Partial<AgentInstance> = {}): AgentInstance {
  return {
    id: 1,
    definitionId: 1,
    projectId: 1,
    name: "test-agent",
    desiredState: "stopped",
    actualState: "new",
    runtimeHandle: {
      driver: "tmux",
      tmuxSession: "bots",
      tmuxWindow: "test",
    },
    lastSnapshot: null,
    lastSnapshotAt: null,
    lastHealthAt: null,
    restartCount: 0,
    lastRestartAt: null,
    sessionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ---------- Tests: desired=stopped ----------

describe("reconcile-loop: desired=stopped", () => {
  test("does nothing when actual=stopped (terminal converged state)", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "stopped",
      actualState: "stopped",
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.stop).not.toHaveBeenCalled();
    expect(driver.start).not.toHaveBeenCalled();
    expect(agentMgr.setActualState).not.toHaveBeenCalled();
  });

  test("does nothing when actual=new and desired=stopped", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "stopped",
      actualState: "new",
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.stop).not.toHaveBeenCalled();
    expect(driver.start).not.toHaveBeenCalled();
  });

  test("calls driver.stop when actual=running", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "stopped",
      actualState: "running",
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.stop).toHaveBeenCalled();
    // Should transition stopping -> stopped
    expect(agentMgr.setActualState).toHaveBeenCalled();
    const calls = (agentMgr.setActualState as any).mock.calls;
    const states = calls.map((c: any[]) => c[1]);
    expect(states).toContain("stopping");
    expect(states).toContain("stopped");
  });

  test("calls driver.stop when actual=starting", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "stopped",
      actualState: "starting",
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.stop).toHaveBeenCalled();
  });

  test("marks failed when driver.stop throws", async () => {
    const driver = makeMockDriver({
      stop: mock(async () => {
        throw new Error("kaboom");
      }),
    });
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "stopped",
      actualState: "running",
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    const calls = (agentMgr.setActualState as any).mock.calls;
    const sawFailed = calls.some((c: any[]) => c[1] === "failed");
    expect(sawFailed).toBe(true);
  });
});

// ---------- Tests: desired=running ----------

describe("reconcile-loop: desired=running", () => {
  test("skips start when runtime_handle is missing projectPath/projectName", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "new",
      runtimeHandle: {
        driver: "tmux",
        tmuxSession: "bots",
        tmuxWindow: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.start).not.toHaveBeenCalled();
    // setActualState called: once 'starting', then 'failed' with explanation
    const calls = (agentMgr.setActualState as any).mock.calls;
    const states = calls.map((c: any[]) => c[1]);
    expect(states).toContain("failed");
  });

  test("calls driver.start when runtime_handle has projectPath/projectName", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "new",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
        tmuxSession: "bots",
        tmuxWindow: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.start).toHaveBeenCalled();
    expect(agentMgr.updateRuntimeHandle).toHaveBeenCalled();
    expect(agentMgr.logEvent).toHaveBeenCalled();
  });

  test("calls driver.start when actual=stopped (cold restart)", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "stopped",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.start).toHaveBeenCalled();
  });

  test("respects restart limit when actual=failed and restartCount >= limit", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "failed",
      restartCount: 5,
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.start).not.toHaveBeenCalled();
    expect(agentMgr.setActualState).not.toHaveBeenCalled();
  });

  test("retries start when actual=failed and restartCount < limit", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "failed",
      restartCount: 1,
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.start).toHaveBeenCalled();
  });

  test("increments restart count when driver.start throws", async () => {
    const driver = makeMockDriver({
      start: mock(async () => {
        throw new Error("start failure");
      }),
    });
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "new",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(agentMgr.incrementRestartCount).toHaveBeenCalled();
    const calls = (agentMgr.setActualState as any).mock.calls;
    const sawFailed = calls.some((c: any[]) => c[1] === "failed");
    expect(sawFailed).toBe(true);
  });

  test("probes health when actual=running", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "running",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.health).toHaveBeenCalled();
    expect(driver.start).not.toHaveBeenCalled();
  });

  test("probes health when actual=starting and promotes to running on success", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "starting",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.health).toHaveBeenCalled();
    const calls = (agentMgr.setActualState as any).mock.calls;
    const states = calls.map((c: any[]) => c[1]);
    expect(states).toContain("running");
  });

  test("marks stopped + increments restart when health=stopped under restart limit", async () => {
    const driver = makeMockDriver({
      health: mock(async () => ({
        state: "stopped" as const,
        lastChecked: new Date(),
      })),
    });
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "running",
      restartCount: 1,
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    const calls = (agentMgr.setActualState as any).mock.calls;
    const states = calls.map((c: any[]) => c[1]);
    expect(states).toContain("stopped");
    expect(agentMgr.incrementRestartCount).toHaveBeenCalled();
  });

  test("marks failed when health.state=stopped and restart limit reached", async () => {
    const driver = makeMockDriver({
      health: mock(async () => ({
        state: "stopped" as const,
        lastChecked: new Date(),
      })),
    });
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "running",
      restartCount: 5,
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    const calls = (agentMgr.setActualState as any).mock.calls;
    const sawFailed = calls.some((c: any[]) => c[1] === "failed");
    expect(sawFailed).toBe(true);
    expect(agentMgr.incrementRestartCount).not.toHaveBeenCalled();
  });

  test("ignores health=unknown (leaves state alone, no transitions)", async () => {
    const driver = makeMockDriver({
      health: mock(async () => ({
        state: "unknown" as const,
        lastChecked: new Date(),
      })),
    });
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "running",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.health).toHaveBeenCalled();
    expect(agentMgr.setActualState).not.toHaveBeenCalled();
    expect(agentMgr.incrementRestartCount).not.toHaveBeenCalled();
  });

  test("swallows health probe errors (logs warn, continues)", async () => {
    const driver = makeMockDriver({
      health: mock(async () => {
        throw new Error("probe failed");
      }),
    });
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "running",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    // Should NOT throw — reconciler swallows probe errors
    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.health).toHaveBeenCalled();
  });
});

// ---------- Tests: desired=paused ----------

describe("reconcile-loop: desired=paused", () => {
  test("is a no-op for forward compatibility", async () => {
    const driver = makeMockDriver();
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "paused",
      actualState: "running",
      runtimeHandle: {
        driver: "tmux",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    expect(driver.start).not.toHaveBeenCalled();
    expect(driver.stop).not.toHaveBeenCalled();
    expect(driver.health).not.toHaveBeenCalled();
    expect(agentMgr.setActualState).not.toHaveBeenCalled();
  });
});

// ---------- Tests: driver missing ----------

describe("reconcile-loop: driver not registered", () => {
  test("skips silently when driver missing (other process owns it)", async () => {
    const mgr = new RuntimeManager();
    // No driver registered
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "new",
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    // Nothing should have happened
    expect(agentMgr.setActualState).not.toHaveBeenCalled();
    expect(agentMgr.logEvent).not.toHaveBeenCalled();
  });

  test("uses driver name from runtime_handle.driver", async () => {
    const driver = makeMockDriver({ name: "tmux" });
    const otherDriver = makeMockDriver({ name: "other" });
    const mgr = new RuntimeManager();
    mgr.registerDriver(driver);
    mgr.registerDriver(otherDriver);
    const agentMgr = makeMockAgentMgr();
    const inst = makeInstance({
      desiredState: "running",
      actualState: "running",
      runtimeHandle: {
        driver: "other",
        projectPath: "/p",
        projectName: "test",
      },
    });

    await (mgr as any).reconcileInstance(inst, agentMgr, 3);

    // Only the "other" driver should have been probed
    expect(otherDriver.health).toHaveBeenCalled();
    expect(driver.health).not.toHaveBeenCalled();
  });
});

// ---------- Tests: startReconcileLoop public API ----------

describe("reconcile-loop: startReconcileLoop", () => {
  test("returns a callable stop function", () => {
    const mgr = new RuntimeManager();
    const agentMgr = makeMockAgentMgr();
    const stop = mgr.startReconcileLoop(agentMgr);
    expect(typeof stop).toBe("function");
    // Calling stop should not throw, even if loop hasn't started ticks yet
    stop();
  });

  test("stop is idempotent — multiple calls do not throw", () => {
    const mgr = new RuntimeManager();
    const agentMgr = makeMockAgentMgr();
    const stop = mgr.startReconcileLoop(agentMgr);
    stop();
    stop();
    stop();
  });
});
