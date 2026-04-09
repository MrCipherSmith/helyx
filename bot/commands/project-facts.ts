import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { listMemories, forget } from "../../memory/long-term.ts";
import { sessionManager } from "../../sessions/manager.ts";
import { sql } from "../../memory/db.ts";

export async function handleProjectFacts(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/project[_-]facts?\s*/, "").trim();

  // Resolve project path: from arg, or from active session
  let projectPath: string | null = null;
  let projectName = "unknown";

  if (arg) {
    projectPath = arg;
    projectName = arg.split("/").at(-1) ?? arg;
  } else {
    const chatId = String(ctx.chat!.id);
    const [chatSess] = await sql`SELECT active_session_id FROM chat_sessions WHERE chat_id = ${chatId}`;
    if (chatSess?.active_session_id) {
      const session = await sessionManager.get(chatSess.active_session_id as number);
      projectPath = session?.projectPath ?? null;
      projectName = session?.name ?? projectPath?.split("/").at(-1) ?? "unknown";
    }
  }

  if (!projectPath) {
    await ctx.reply("No active project session. Use /project_facts <path> or /switch to a project session.");
    return;
  }

  // Query project facts
  const memories = await listMemories({
    type: "fact",
    projectPath,
    limit: 50,
  });

  // Filter to project-tagged facts
  const projectFacts = memories.filter((m) => Array.isArray(m.tags) && m.tags.includes("project"));

  if (projectFacts.length === 0) {
    await ctx.reply(
      `No project facts saved for <b>${escapeHtml(projectName)}</b> yet.\n\n` +
      `Facts are saved automatically at session end, or you can ask Claude to <code>remember(type="fact")</code> during a session.`,
      { parse_mode: "HTML" },
    );
    return;
  }

  const lines = projectFacts.slice(0, 25).map((m, i) => {
    const tags = Array.isArray(m.tags) ? m.tags.filter((t: string) => t !== "project") : [];
    const tagStr = tags.length > 0 ? `[${tags.join(", ")}] ` : "";
    const preview = m.content.slice(0, 120);
    return `${i + 1}. <code>#${m.id}</code> ${tagStr}${escapeHtml(preview)}`;
  });

  const header = `📚 <b>Project Facts — ${escapeHtml(projectName)}</b> (${projectFacts.length}):\n\n`;
  const footer = projectFacts.length > 25 ? `\n\n…and ${projectFacts.length - 25} more. Use /forget &lt;id&gt; to remove any.` : "";

  await ctx.reply(header + lines.join("\n") + footer, { parse_mode: "HTML" });
}

export async function handleProjectFactsCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const match = data.match(/^forget_project_fact:(\d+)$/);
  if (!match) return;

  const id = Number(match[1]);
  const deleted = await forget(id);
  await ctx.answerCallbackQuery(deleted ? `Deleted fact #${id}` : `Fact #${id} not found`);
  if (deleted) {
    await ctx.editMessageText(`✓ Deleted fact #${id}`);
  }
}

export async function handleProjectScan(ctx: Context): Promise<void> {
  const { scanProjectKnowledge } = await import("../../memory/project-scanner.ts");

  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/project[_-]scan\s*/, "").trim();

  let projectPath: string | null = null;
  let projectName = "unknown";

  if (arg) {
    projectPath = arg;
    projectName = arg.split("/").at(-1) ?? arg;
  } else {
    const chatId = String(ctx.chat!.id);
    const [chatSess] = await sql`SELECT active_session_id FROM chat_sessions WHERE chat_id = ${chatId}`;
    if (chatSess?.active_session_id) {
      const session = await sessionManager.get(chatSess.active_session_id as number);
      projectPath = session?.projectPath ?? null;
      projectName = session?.name ?? projectPath?.split("/").at(-1) ?? "unknown";
    }
  }

  if (!projectPath) {
    await ctx.reply("No active project session. Use /project_scan <path> or /switch to a project session.");
    return;
  }

  await ctx.reply(`Scanning <b>${escapeHtml(projectName)}</b>…`, { parse_mode: "HTML" });

  const count = await scanProjectKnowledge(projectPath, true); // force rescan
  await ctx.reply(`✓ Scanned <b>${escapeHtml(projectName)}</b>: ${count} knowledge facts saved.`, { parse_mode: "HTML" });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
