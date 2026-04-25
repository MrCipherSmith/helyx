/**
 * /orchestrate <description> — create a root agent_task and assign it to an agent.
 *
 * Phase 7 MVP: Capability matching only. LLM-driven decomposition is deferred
 * to Phase 7v2 (will use llm/client to split description into subtasks).
 *
 * Selection preference: orchestrate > code > review. First capability with a
 * matching agent wins. If none match, the task is created unassigned and the
 * user is asked to assign it manually via /task <id> assign <name>.
 */
import type { Context } from "grammy";
import { orchestrator } from "../../agents/orchestrator.ts";
import { escapeHtml } from "../format.ts";

export async function handleOrchestrate(ctx: Context): Promise<void> {
  const description = ((ctx.match as string) ?? "").trim();
  if (!description) {
    await ctx.reply(
      "Usage: <code>/orchestrate &lt;task description&gt;</code>\n\n" +
      "<i>Creates a root task and assigns it to an agent with matching capabilities.</i>",
      { parse_mode: "HTML" },
    );
    return;
  }

  // Use first line as title, full text as description (only if multi-line)
  const lines = description.split("\n");
  const title = lines[0].slice(0, 200);
  const fullDesc = lines.length > 1 ? description : null;

  // Capability preference: orchestrate > code > review
  const capabilityCandidates: string[][] = [["orchestrate"], ["code"], ["review"]];
  for (const required of capabilityCandidates) {
    const agent = await orchestrator.selectAgent(required);
    if (!agent) continue;
    const task = await orchestrator.createTask({
      title,
      description: fullDesc ?? undefined,
      agentInstanceId: agent.id,
      payload: { source: "telegram /orchestrate", required_capabilities: required },
    });
    await ctx.reply(
      `✓ Created task <b>#${task.id}</b>: ${escapeHtml(title)}\n\n` +
      `Assigned to <b>${escapeHtml(agent.name)}</b> (caps: ${required.join(", ")})\n` +
      `Status: <code>pending</code>\n\n` +
      `Use <code>/task ${task.id}</code> to view details.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  // No matching agent — create unassigned task
  const task = await orchestrator.createTask({
    title,
    description: fullDesc ?? undefined,
    payload: { source: "telegram /orchestrate", agent_selection: "no_match" },
  });
  await ctx.reply(
    `⚠ Created task <b>#${task.id}</b>: ${escapeHtml(title)}\n\n` +
    `<i>No agent with required capabilities is currently available.</i>\n` +
    `Use <code>/task ${task.id} assign &lt;agent&gt;</code> to assign manually, or\n` +
    `<code>/agents</code> to start an agent.`,
    { parse_mode: "HTML" },
  );
}
