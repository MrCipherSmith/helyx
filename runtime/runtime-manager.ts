/**
 * RuntimeManager — minimal facade over a registry of {@link RuntimeDriver}s.
 *
 * Each consumer (admin-daemon on the host, channel/ inside Docker, tests)
 * instantiates and registers its own configured drivers. Drivers are NOT
 * auto-registered here because they require environment-specific config
 * (e.g. `TmuxDriver` needs a `runCliPath` and a `runShell` injection).
 */
import { RuntimeDriver, RuntimeDriverError } from "./types.ts";
import type { AgentManager, AgentInstance } from "../agents/agent-manager.ts";
import { CONFIG } from "../config.ts";
import { logger } from "../logger.ts";

export class RuntimeManager {
  private readonly drivers = new Map<string, RuntimeDriver>();

  /** Register a driver. Throws if a driver with the same name already exists. */
  registerDriver(driver: RuntimeDriver): void {
    if (this.drivers.has(driver.name)) {
      throw new RuntimeDriverError(
        driver.name,
        "validation",
        `driver "${driver.name}" already registered`,
      );
    }
    this.drivers.set(driver.name, driver);
  }

  /** Look up a driver by name. Throws {@link RuntimeDriverError} if missing. */
  getDriver(name: string): RuntimeDriver {
    const driver = this.drivers.get(name);
    if (!driver) {
      const available = [...this.drivers.keys()].join(", ") || "(none)";
      throw new RuntimeDriverError(
        name,
        "not_found",
        `no driver registered for "${name}". Available: ${available}`,
      );
    }
    return driver;
  }

  /** Returns true iff a driver with the given name is registered. */
  hasDriver(name: string): boolean {
    return this.drivers.has(name);
  }

  /** List all registered driver names. */
  listDrivers(): string[] {
    return [...this.drivers.keys()];
  }

  /**
   * Start a reconcile loop that converges agent_instance.actual_state to desired_state.
   *
   * Reconciliation rules:
   *   desired=running, actual ∈ {new, stopped, failed} → call driver.start, set actual=starting
   *   desired=running, actual=starting             → probe driver.health; if running, set actual=running
   *   desired=running, actual ∈ {idle, busy, running}, health ∈ {stopped, unknown} → restart (if restartCount < limit)
   *   desired=stopped, actual ∈ {running, idle, busy, starting} → call driver.stop, set actual=stopping
   *   desired=stopped, actual=stopping              → probe; if stopped, set actual=stopped
   *   desired=paused                               → no-op for Phase 4 (forward compat)
   *
   * Loop runs every CONFIG.AGENT_RECONCILE_INTERVAL_MS ms.
   * Skipped if env DEFAULT_RUNTIME_DRIVER is empty or AGENT_RECONCILE_INTERVAL_MS is 0.
   *
   * Returns a stop function.
   */
  startReconcileLoop(agentMgr: AgentManager): () => void {
    const intervalMs = CONFIG.AGENT_RECONCILE_INTERVAL_MS;
    if (intervalMs <= 0) {
      logger.info("[runtime] reconcile loop disabled (AGENT_RECONCILE_INTERVAL_MS <= 0)");
      return () => {};
    }
    const restartLimit = CONFIG.AGENT_RESTART_LIMIT;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      try {
        const instances = await agentMgr.listInstances();
        for (const inst of instances) {
          await this.reconcileInstance(inst, agentMgr, restartLimit).catch((err) => {
            logger.warn({ instanceId: inst.id, err: String(err) }, "reconcile error for instance");
          });
        }
      } catch (err) {
        logger.error({ err: String(err) }, "reconcile loop iteration failed");
      }
    };

    logger.info({ intervalMs, restartLimit }, "[runtime] reconcile loop started");
    const handle = setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      clearInterval(handle);
      logger.info("[runtime] reconcile loop stopped");
    };
  }

  private async reconcileInstance(
    inst: AgentInstance,
    agentMgr: AgentManager,
    restartLimit: number,
  ): Promise<void> {
    const driverName = (inst.runtimeHandle.driver as string) ?? CONFIG.DEFAULT_RUNTIME_DRIVER ?? "tmux";
    if (!this.hasDriver(driverName)) {
      // Driver not registered in this process — skip. (Other processes may handle it.)
      return;
    }
    const driver = this.getDriver(driverName);
    const handle = inst.runtimeHandle as any; // RuntimeHandle shape

    // desired=running
    if (inst.desiredState === "running") {
      if (inst.actualState === "new" || inst.actualState === "stopped" || inst.actualState === "failed") {
        // Need to start
        if (inst.restartCount >= restartLimit && inst.actualState === "failed") {
          logger.warn({ instanceId: inst.id, restartCount: inst.restartCount }, "restart limit reached, leaving in failed state");
          return;
        }
        try {
          await agentMgr.setActualState(inst.id, "starting");
          await agentMgr.logEvent({ agentInstanceId: inst.id, eventType: "start_attempt" });
          // Driver.start needs RuntimeStartConfig — derive from handle/project
          // For now we cannot start agents that lack projectPath in handle. Tmux driver requires path+name.
          if (!handle.projectPath || !handle.projectName) {
            // Bootstrapped instances don't have these. Need a project lookup.
            // For Wave 2, we skip — Wave 4 will integrate project-service to fill these.
            logger.warn({ instanceId: inst.id }, "missing projectPath/projectName in runtime_handle — skipping start");
            await agentMgr.setActualState(inst.id, "failed", "missing projectPath/projectName in runtime_handle");
            return;
          }
          const updatedHandle = await driver.start(handle, {
            projectPath: handle.projectPath,
            projectName: handle.projectName,
          });
          await agentMgr.updateRuntimeHandle(inst.id, updatedHandle);
          // Don't immediately mark as running — let next tick verify via health
        } catch (err) {
          await agentMgr.setActualState(inst.id, "failed", `start failed: ${String(err)}`);
          await agentMgr.incrementRestartCount(inst.id);
        }
        return;
      }

      // actual ∈ {starting, running, idle, busy} — probe health
      try {
        const health = await driver.health(handle);
        if (health.state === "running") {
          if (inst.actualState !== "running" && inst.actualState !== "idle" && inst.actualState !== "busy") {
            await agentMgr.setActualState(inst.id, "running");
          } else {
            await agentMgr.setActualState(inst.id, inst.actualState);  // touch lastHealthAt
          }
        } else if (health.state === "stopped") {
          // Unexpected — restart if under limit
          if (inst.restartCount < restartLimit) {
            await agentMgr.setActualState(inst.id, "stopped", "health probe found stopped, will restart");
            await agentMgr.incrementRestartCount(inst.id);
          } else {
            await agentMgr.setActualState(inst.id, "failed", "health probe found stopped, restart limit reached");
          }
        }
        // health.state === "unknown" — leave actualState alone
      } catch (err) {
        logger.warn({ instanceId: inst.id, err: String(err) }, "health probe failed");
      }
      return;
    }

    // desired=stopped
    if (inst.desiredState === "stopped") {
      if (
        inst.actualState === "running" ||
        inst.actualState === "idle" ||
        inst.actualState === "busy" ||
        inst.actualState === "starting"
      ) {
        try {
          await agentMgr.setActualState(inst.id, "stopping");
          await driver.stop(handle);
          await agentMgr.setActualState(inst.id, "stopped");
        } catch (err) {
          await agentMgr.setActualState(inst.id, "failed", `stop failed: ${String(err)}`);
        }
        return;
      }
      // actual ∈ {new, stopped, failed} — already where we want
      return;
    }

    // desired=paused — no-op (forward compat)
  }
}

/**
 * Singleton instance — STARTS EMPTY by design.
 *
 * Callers MUST call `runtimeManager.registerDriver(driver)` before any
 * `runtimeManager.getDriver(name)` call. There is no auto-registration here
 * because driver construction requires environment-specific config that only
 * the entry point (admin-daemon, channel/) knows.
 *
 * Today only `admin-daemon.ts` registers a driver (TmuxDriver, on host).
 * If Phase 4+ adds more entry points, each must register the drivers it needs.
 * Calling `getDriver("tmux")` before registration throws
 * `RuntimeDriverError(code: "not_found")` — wrap in a try/catch or use
 * `hasDriver(name)` to probe.
 */
export const runtimeManager = new RuntimeManager();
