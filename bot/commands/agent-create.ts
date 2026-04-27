/**
 * /agent_create — create a new agent_instance from Telegram.
 * /agent_delete — confirm-then-delete an existing agent_instance.
 *
 * Closes the gap surfaced after v1.37.0: previously instances could
 * only be inserted via direct SQL or DB migrations. The bot/dashboard
 * read+start+stop them but couldn't create new ones.
 *
 * Usage:
 *   /agent_create <instance_name> <definition_name> [project_name]
 *
 * Examples:
 *   /agent_create helyx:planner planner-default helyx
 *   /agent_create my-orchestrator orchestrator-default
 *
 * Validation:
 *   - definition_name must exist in agent_definitions AND enabled=true
 *   - project_name (if given) must exist
 *   - (project_id, instance_name) must be unique — DB UNIQUE constraint
 *   - instance_name lowered shape: keep as-is, the tmux-driver sanitizes
 *     it for window name (`:`/`/` → `_`).
 *
 * Created with desired_state='running' so the reconciler picks it up
 * on the next ~5s tick. To create a stopped instance: pass `--stopped`
 * as a 4th positional arg.
 *
 * /agent_delete:
 *   /agent_delete <instance_id>
 *
 * Two-step flow with inline confirmation. Sets desired=stopped, then
 * deletes the row only after the reconciler has settled (timeout: 30s).
 * If the agent is currently running, the reconciler tears down the
 * tmux window before the row is removed.
 */

import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { agentManager } from "../../agents/agent-manager.ts";
import { projectService } from "../../services/project-service.ts";
import { sql } from "../../memory/db.ts";

const USAGE_CREATE =
  "<b>Usage:</b> <code>/agent_create &lt;name&gt; &lt;definition&gt; [project] [--stopped]</code>\n\n" +
  "<b>Examples:</b>\n" +
  "<code>/agent_create helyx:planner planner-default helyx</code>\n" +
  "<code>/agent_create my-bot orchestrator-default --stopped</code>\n\n" +
  "<b>Tips:</b>\n" +
  "• Use <code>/agents</code> to view existing instances\n" +
  "• Definitions: <code>planner-default</code>, <code>reviewer-default</code>, <code>orchestrator-default</code>, <code>claude-code-default</code>\n" +
  "• PRD §17.4 naming: <code>&lt;project&gt;:&lt;role&gt;</code>";

export async function handleAgentCreate(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const args = text.split(/\s+/).slice(1);

  if (args.length < 2) {
    await ctx.reply(USAGE_CREATE, { parse_mode: "HTML" });
    return;
  }

  const [instanceName, definitionName, ...rest] = args;
  let projectName: string | null = null;
  let desiredState: "running" | "stopped" = "running";
  for (const r of rest) {
    if (r === "--stopped") {
      desiredState = "stopped";
    } else if (!projectName && !r.startsWith("--")) {
      projectName = r;
    }
  }

  const def = await agentManager.getDefinitionByName(definitionName!);
  if (!def) {
    await ctx.reply(
      `❌ agent_definition <code>${escapeHtml(definitionName!)}</code> not found.\n\n` +
        `Run <code>/agents</code> to see available roles, or check <code>agent_definitions</code> in the DB.`,
      { parse_mode: "HTML" },
    );
    return;
  }
  if (!def.enabled) {
    await ctx.reply(
      `❌ agent_definition <code>${escapeHtml(definitionName!)}</code> is disabled.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  let projectId: number | null = null;
  if (projectName) {
    const proj = await projectService.getByName(projectName);
    if (!proj) {
      await ctx.reply(
        `❌ project <code>${escapeHtml(projectName)}</code> not found.\n\n` +
          `Run <code>/projects</code> to list, or <code>/project_add &lt;path&gt;</code> to add.`,
        { parse_mode: "HTML" },
      );
      return;
    }
    projectId = proj.id;

    // Pre-flight uniqueness check — DB has UNIQUE (project_id, name) but
    // surfacing the conflict ourselves yields a clearer error than the
    // raw "duplicate key" message.
    const existing = await agentManager.getInstanceByName(projectId, instanceName!);
    if (existing) {
      await ctx.reply(
        `❌ instance <code>${escapeHtml(instanceName!)}</code> already exists in project <code>${escapeHtml(projectName)}</code> (id=${existing.id}).`,
        { parse_mode: "HTML" },
      );
      return;
    }
  } else {
    // Project-less instance: uniqueness check via name + null project_id.
    const [existingRow] = (await sql`
      SELECT id FROM agent_instances WHERE project_id IS NULL AND name = ${instanceName!} LIMIT 1
    `) as any[];
    if (existingRow) {
      await ctx.reply(
        `❌ instance <code>${escapeHtml(instanceName!)}</code> already exists (id=${existingRow.id}, no project).`,
        { parse_mode: "HTML" },
      );
      return;
    }
  }

  try {
    const inst = await agentManager.createInstance({
      definitionId: def.id,
      projectId,
      name: instanceName!,
      desiredState,
    });
    await agentManager.logEvent({
      agentInstanceId: inst.id,
      eventType: "instance_created",
      message: `Created via Telegram /agent_create`,
      metadata: {
        source: "telegram",
        definition_name: definitionName,
        project_name: projectName,
        desired_state: desiredState,
      },
    });

    const projDisplay = projectName ?? "(no project)";
    const stateNote = desiredState === "running"
      ? "\n\n<i>Reconciler will pick it up within ~5s and start the runtime.</i>"
      : "\n\n<i>Created stopped — start later from <code>/agents</code>.</i>";
    await ctx.reply(
      `✅ Created agent_instance <code>${escapeHtml(instanceName!)}</code>:\n\n` +
        `• id: <code>${inst.id}</code>\n` +
        `• definition: <code>${escapeHtml(definitionName!)}</code> (id=${def.id})\n` +
        `• project: <code>${escapeHtml(projDisplay)}</code>\n` +
        `• desired_state: <code>${desiredState}</code>` +
        stateNote,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    await ctx.reply(
      `❌ Failed to create instance: <code>${escapeHtml(String(err).slice(0, 200))}</code>`,
      { parse_mode: "HTML" },
    );
  }
}

const USAGE_DELETE =
  "<b>Usage:</b> <code>/agent_delete &lt;instance_id&gt;</code>\n\n" +
  "Stops the agent (desired=stopped) and waits for the reconciler to settle, " +
  "then deletes the row.\n\n" +
  "<b>Note:</b> tasks assigned to this agent will become unassigned " +
  "(<code>agent_instance_id = NULL</code>); use <code>/task &lt;id&gt; assign &lt;agent&gt;</code> to reassign.";

export async function handleAgentDelete(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const args = text.split(/\s+/).slice(1);

  if (args.length === 0 || !/^\d+$/.test(args[0]!)) {
    await ctx.reply(USAGE_DELETE, { parse_mode: "HTML" });
    return;
  }

  const id = parseInt(args[0]!, 10);
  const inst = await agentManager.getInstance(id);
  if (!inst) {
    await ctx.reply(`❌ instance id=${id} not found.`);
    return;
  }

  const keyboard = new InlineKeyboard()
    .text(`✅ Confirm delete`, `agent_delete:confirm:${id}`)
    .text(`❌ Cancel`, `agent_delete:cancel:${id}`);

  await ctx.reply(
    `⚠️ Delete agent_instance <b>${escapeHtml(inst.name)}</b> (id=${id})?\n\n` +
      `• desired_state: <code>${inst.desiredState}</code>\n` +
      `• actual_state: <code>${inst.actualState}</code>\n\n` +
      `This will set <code>desired=stopped</code>, wait up to 30s for the reconciler ` +
      `to settle, then DELETE the row. Tasks become unassigned.`,
    { parse_mode: "HTML", reply_markup: keyboard },
  );
}

/** Callback handler for `agent_delete:confirm|cancel:<id>`. */
export async function handleAgentDeleteCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data;
  const m = data?.match(/^agent_delete:(confirm|cancel):(\d+)$/);
  if (!m) {
    await ctx.answerCallbackQuery({ text: "Invalid callback" });
    return;
  }
  const action = m[1]!;
  const id = parseInt(m[2]!, 10);

  if (action === "cancel") {
    await ctx.answerCallbackQuery({ text: "Delete cancelled" });
    await ctx.editMessageText("❌ Delete cancelled.", { parse_mode: "HTML" });
    return;
  }

  const inst = await agentManager.getInstance(id);
  if (!inst) {
    await ctx.answerCallbackQuery({ text: "Already gone", show_alert: false });
    await ctx.editMessageText(`Instance id=${id} no longer exists.`);
    return;
  }

  await ctx.answerCallbackQuery({ text: "Stopping..." });

  try {
    // 1. Mark stopped so the reconciler tears down the runtime.
    await agentManager.setDesiredState(id, "stopped", "telegram /agent_delete");

    // 2. Poll for the reconciler to settle. The reconcile interval is ~5s
    //    plus driver.stop latency (tmux kill-window is fast). 30s budget
    //    covers the typical case; if the runtime is wedged we still
    //    delete to unblock the operator (orphan window can be closed
    //    manually via /tmux_kill).
    const settled = await waitForState(id, "stopped", 30_000);

    // 3. Delete. The deleteInstance method does not interact with the
    //    runtime — relies on step 2 to have torn it down.
    const removed = await agentManager.deleteInstance(id);

    if (!removed) {
      await ctx.editMessageText(
        `⚠️ Instance <code>${escapeHtml(inst.name)}</code> (id=${id}) was already gone before delete.`,
        { parse_mode: "HTML" },
      );
      return;
    }

    const settledNote = settled
      ? ""
      : "\n\n⚠️ <i>Reconciler did not settle within 30s — runtime may have left an orphan tmux window. Check <code>/agents</code> for stragglers.</i>";

    await ctx.editMessageText(
      `🗑 Deleted <code>${escapeHtml(inst.name)}</code> (id=${id}).${settledNote}`,
      { parse_mode: "HTML" },
    );
  } catch (err) {
    await ctx.editMessageText(
      `❌ Delete failed: <code>${escapeHtml(String(err).slice(0, 200))}</code>`,
      { parse_mode: "HTML" },
    );
  }
}

/**
 * Poll agent_instances.actual_state until it equals `target`, or the
 * timeout elapses. Returns true iff the target was observed.
 *
 * Plain polling with a short interval — not a notification subscription
 * because the reconciler does not emit pg_notify events. The 500ms tick
 * is short enough that operators see snappy feedback but rarely runs
 * more than ~10 times before the typical reconcile completes.
 */
async function waitForState(
  id: number,
  target: string,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inst = await agentManager.getInstance(id);
    if (!inst) return true; // already gone — caller's intent satisfied
    if (inst.actualState === target) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
