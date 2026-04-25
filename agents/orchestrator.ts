/**
 * Orchestrator — manages agent_tasks lifecycle and assigns work to agent_instances.
 *
 * Phase 7 MVP scope:
 *   - CRUD over agent_tasks (create, get, list, update status)
 *   - Hierarchy: parent_task_id linking, getTaskTree
 *   - Agent selection by capability matching
 *   - Audit events on every state change
 *
 * Phase 7v2 (deferred):
 *   - LLM-driven task decomposition (calls llm/client to split a description into subtasks)
 *   - Auto-approval workflows for waiting_approval state
 *   - Cross-agent task reassignment on failure
 */
import { sql } from "../memory/db.ts";
import { logger } from "../logger.ts";
import { agentManager, type AgentInstance } from "./agent-manager.ts";

export type TaskStatus =
  | "pending" | "in_progress" | "blocked" | "review" | "done" | "cancelled" | "failed";

export interface AgentTask {
  id: number;
  agentInstanceId: number | null;
  parentTaskId: number | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  priority: number;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  agentInstanceId?: number | null;  // explicit assignment, otherwise selectAgent is called
  parentTaskId?: number;
  payload?: Record<string, unknown>;
  priority?: number;
  /** When provided AND agentInstanceId is omitted, selectAgent uses these to filter. */
  requiredCapabilities?: string[];
}

export interface TaskNode extends AgentTask {
  children: TaskNode[];
}

function rowToTask(r: any): AgentTask {
  return {
    id: r.id,
    agentInstanceId: r.agent_instance_id,
    parentTaskId: r.parent_task_id,
    title: r.title,
    description: r.description,
    status: r.status as TaskStatus,
    payload: r.payload ?? {},
    result: r.result ?? null,
    priority: r.priority ?? 0,
    createdAt: r.created_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    updatedAt: r.updated_at,
  };
}

export class Orchestrator {
  // ---------- Task CRUD ----------

  async createTask(input: CreateTaskInput): Promise<AgentTask> {
    let agentInstanceId = input.agentInstanceId ?? null;

    // If no explicit assignment, try to find an agent matching required capabilities
    if (agentInstanceId === null && input.requiredCapabilities && input.requiredCapabilities.length > 0) {
      const selected = await this.selectAgent(input.requiredCapabilities);
      if (selected) agentInstanceId = selected.id;
    }

    return await sql.begin(async (tx) => {
      const [r] = await tx`
        INSERT INTO agent_tasks (agent_instance_id, parent_task_id, title, description, status, payload, priority)
        VALUES (
          ${agentInstanceId},
          ${input.parentTaskId ?? null},
          ${input.title},
          ${input.description ?? null},
          'pending',
          ${JSON.stringify(input.payload ?? {})}::jsonb,
          ${input.priority ?? 0}
        )
        RETURNING *
      ` as any[];

      // Audit event on the assigned agent (if any)
      if (agentInstanceId !== null) {
        await tx`
          INSERT INTO agent_events (agent_instance_id, task_id, event_type, message, metadata)
          VALUES (
            ${agentInstanceId},
            ${r.id},
            'task_assigned',
            ${`task #${r.id}: ${r.title}`},
            ${JSON.stringify({ priority: r.priority, parent_task_id: r.parent_task_id })}::jsonb
          )
        `;
      }
      return rowToTask(r);
    }) as AgentTask;
  }

  async getTask(id: number): Promise<AgentTask | null> {
    const [r] = await sql`SELECT * FROM agent_tasks WHERE id = ${id} LIMIT 1` as any[];
    return r ? rowToTask(r) : null;
  }

  async listTasks(filter?: {
    status?: TaskStatus;
    agentInstanceId?: number;
    parentTaskId?: number | null;  // null = root tasks only
  }): Promise<AgentTask[]> {
    let rows: any[];
    if (filter?.status) {
      rows = await sql`SELECT * FROM agent_tasks WHERE status = ${filter.status} ORDER BY priority DESC, id` as any[];
    } else if (filter?.agentInstanceId !== undefined) {
      rows = await sql`SELECT * FROM agent_tasks WHERE agent_instance_id = ${filter.agentInstanceId} ORDER BY priority DESC, id` as any[];
    } else if (filter?.parentTaskId === null) {
      rows = await sql`SELECT * FROM agent_tasks WHERE parent_task_id IS NULL ORDER BY priority DESC, id` as any[];
    } else if (filter?.parentTaskId !== undefined) {
      rows = await sql`SELECT * FROM agent_tasks WHERE parent_task_id = ${filter.parentTaskId} ORDER BY priority DESC, id` as any[];
    } else {
      rows = await sql`SELECT * FROM agent_tasks ORDER BY id DESC LIMIT 100` as any[];
    }
    return rows.map(rowToTask);
  }

  async getTaskTree(rootId: number): Promise<TaskNode | null> {
    // Recursive fetch of all descendants. Bound by depth cap to prevent runaway recursion.
    const root = await this.getTask(rootId);
    if (!root) return null;

    const buildNode = async (task: AgentTask, depth: number): Promise<TaskNode> => {
      if (depth >= 10) return { ...task, children: [] }; // cap recursion
      const childRows = await sql`SELECT * FROM agent_tasks WHERE parent_task_id = ${task.id} ORDER BY priority DESC, id` as any[];
      const children = await Promise.all(childRows.map((r) => buildNode(rowToTask(r), depth + 1)));
      return { ...task, children };
    };
    return await buildNode(root, 0);
  }

  // ---------- State transitions ----------

  /**
   * Set task status. Records an event. Returns the updated task.
   * Side effects:
   *   - status='in_progress' → set started_at
   *   - status='done' | 'cancelled' | 'failed' → set completed_at
   */
  async setStatus(taskId: number, status: TaskStatus, message?: string): Promise<AgentTask> {
    return await sql.begin(async (tx) => {
      const [before] = await tx`SELECT * FROM agent_tasks WHERE id = ${taskId} FOR UPDATE` as any[];
      if (!before) throw new Error(`agent_task ${taskId} not found`);
      if (before.status === status) return rowToTask(before);

      // Compute timestamp side effects
      const startTs = status === "in_progress" && !before.started_at ? sql`now()` : sql`started_at`;
      const completeTs = (status === "done" || status === "cancelled" || status === "failed") ? sql`now()` : sql`completed_at`;

      const [after] = await tx`
        UPDATE agent_tasks
        SET status = ${status},
            started_at = ${startTs},
            completed_at = ${completeTs},
            updated_at = now()
        WHERE id = ${taskId}
        RETURNING *
      ` as any[];

      if (before.agent_instance_id) {
        await tx`
          INSERT INTO agent_events (agent_instance_id, task_id, event_type, from_state, to_state, message)
          VALUES (
            ${before.agent_instance_id},
            ${taskId},
            'task_status_change',
            ${before.status},
            ${status},
            ${message ?? null}
          )
        `;
      }
      logger.info({ taskId, fromStatus: before.status, toStatus: status, message }, "task status changed");
      return rowToTask(after);
    }) as AgentTask;
  }

  /** Reassign a task to a different agent. Records event on both old and new agents. */
  async assignTask(taskId: number, agentInstanceId: number | null): Promise<AgentTask> {
    return await sql.begin(async (tx) => {
      const [before] = await tx`SELECT * FROM agent_tasks WHERE id = ${taskId} FOR UPDATE` as any[];
      if (!before) throw new Error(`agent_task ${taskId} not found`);
      if (before.agent_instance_id === agentInstanceId) return rowToTask(before);

      const [after] = await tx`
        UPDATE agent_tasks
        SET agent_instance_id = ${agentInstanceId}, updated_at = now()
        WHERE id = ${taskId}
        RETURNING *
      ` as any[];

      // Event on old agent (unassigned)
      if (before.agent_instance_id) {
        await tx`
          INSERT INTO agent_events (agent_instance_id, task_id, event_type, message)
          VALUES (${before.agent_instance_id}, ${taskId}, 'task_unassigned', ${`task #${taskId}: ${before.title}`})
        `;
      }
      // Event on new agent (assigned)
      if (agentInstanceId) {
        await tx`
          INSERT INTO agent_events (agent_instance_id, task_id, event_type, message)
          VALUES (${agentInstanceId}, ${taskId}, 'task_assigned', ${`task #${taskId}: ${before.title}`})
        `;
      }
      return rowToTask(after);
    }) as AgentTask;
  }

  /** Set task result (final output). */
  async setResult(taskId: number, result: Record<string, unknown>): Promise<AgentTask> {
    const [r] = await sql`
      UPDATE agent_tasks
      SET result = ${JSON.stringify(result)}::jsonb, updated_at = now()
      WHERE id = ${taskId}
      RETURNING *
    ` as any[];
    if (!r) throw new Error(`agent_task ${taskId} not found`);
    return rowToTask(r);
  }

  // ---------- Subtask helpers ----------

  /** Add multiple subtasks under a parent. Useful after manual decomposition. */
  async addSubtasks(parentTaskId: number, subtasks: CreateTaskInput[]): Promise<AgentTask[]> {
    const results: AgentTask[] = [];
    for (const sub of subtasks) {
      const created = await this.createTask({ ...sub, parentTaskId });
      results.push(created);
    }
    return results;
  }

  // ---------- Agent selection ----------

  /**
   * Select an agent_instance whose definition.capabilities is a superset of `required`.
   * Prefers running agents over stopped, then highest-priority match.
   * Returns null if no agent matches.
   */
  async selectAgent(required: string[]): Promise<AgentInstance | null> {
    if (required.length === 0) return null;

    // Find agent_instances whose definition has ALL required capabilities.
    // Use jsonb @> (contains) operator: capabilities @> '["a","b"]'
    const requiredJson = JSON.stringify(required);
    const rows = await sql`
      SELECT ai.*, ad.capabilities, ad.runtime_type, ai.actual_state
      FROM agent_instances ai
      JOIN agent_definitions ad ON ad.id = ai.definition_id
      WHERE ad.enabled = true
        AND ai.desired_state != 'stopped'
        AND ad.capabilities @> ${requiredJson}::jsonb
      ORDER BY
        CASE ai.actual_state
          WHEN 'running' THEN 0
          WHEN 'idle' THEN 0
          WHEN 'busy' THEN 1
          WHEN 'starting' THEN 2
          ELSE 3
        END,
        ai.id
      LIMIT 1
    ` as any[];

    if (rows.length === 0) return null;

    // Build AgentInstance shape via agentManager.getInstance for canonical mapping
    return await agentManager.getInstance(Number(rows[0].id));
  }
}

export const orchestrator = new Orchestrator();
