import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { projectService } from "../../services/project-service.ts";

export async function handleProjects(ctx: Context): Promise<void> {
  const projects = await projectService.list();

  if (projects.length === 0) {
    await ctx.reply("No projects configured.\nUse /project-add to add one.");
    return;
  }

  const kb = new InlineKeyboard();
  const lines: string[] = ["Projects:\n"];

  for (const p of projects) {
    const isActive = p.session_status === "active";
    const icon = isActive ? "🟢" : "⚪";
    lines.push(`${icon} ${p.name}  (${p.path})`);
    if (isActive) {
      kb.text(`⏹ Stop ${p.name}`, `proj:stop:${p.id}`).row();
    } else {
      kb.text(`▶️ Start ${p.name}`, `proj:start:${p.id}`).row();
    }
  }

  await ctx.reply(lines.join("\n"), { reply_markup: kb });
}

export async function handleProjectCallback(ctx: Context): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const parts = data.split(":");
  const action = parts[1]; // "start" | "stop"
  const id = Number(parts[2]);

  if (!action || !id) {
    await ctx.answerCallbackQuery({ text: "Invalid" });
    return;
  }

  const project = await projectService.get(id);
  if (!project) {
    await ctx.answerCallbackQuery({ text: "Project not found" });
    return;
  }

  if (action === "start") {
    await projectService.start(id);
  } else {
    await projectService.stop(id);
  }

  await ctx.answerCallbackQuery({
    text: action === "start" ? `Starting ${project.name}...` : `Stopping ${project.name}...`,
  });

  // Refresh the message
  await ctx.deleteMessage().catch(() => {});
  await handleProjects(ctx);
}
