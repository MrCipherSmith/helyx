import type { Context } from "grammy";
import { basename } from "path";
import { setPendingInput } from "../handlers.ts";
import { loadProjects, saveProjects } from "./projects.ts";

export async function handleProjectAdd(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/project[_-]add\s*/, "").trim();

  if (arg) {
    await addProject(ctx, arg);
  } else {
    const chatId = String(ctx.chat!.id);
    await ctx.reply("Enter project path:");
    setPendingInput(chatId, async (replyCtx) => {
      const path = replyCtx.message?.text?.trim() ?? "";
      await addProject(replyCtx, path);
    });
  }
}

async function addProject(ctx: Context, path: string): Promise<void> {
  if (!path.startsWith("/")) {
    await ctx.reply("Path must be absolute (start with /).");
    return;
  }

  const projects = await loadProjects();
  if (projects.find((p) => p.path === path)) {
    await ctx.reply(`Project already exists: ${basename(path)}`);
    return;
  }

  const name = basename(path);
  projects.push({ name, path });
  await saveProjects(projects);
  await ctx.reply(`✅ Added: ${name}\n${path}\n\nUse /projects to start it.`);
}
