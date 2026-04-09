import type { Context } from "grammy";
import { join } from "path";
import { setPendingInput } from "../handlers.ts";
import { projectService } from "../../services/project-service.ts";
import { CONFIG } from "../../config.ts";
import { logger } from "../../logger.ts";

export async function handleProjectAdd(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/project[_-]add\s*/, "").trim();

  if (arg) {
    await addProject(ctx, arg);
  } else {
    const chatId = String(ctx.chat!.id);
    const hostProjects = CONFIG.HOST_PROJECTS_DIR ?? "/home/user";
    await ctx.reply(`Enter project path:\ne.g. ${join(hostProjects, "my-project")}`);
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

  const name = path.split("/").pop() ?? path;

  const project = await projectService.create(name, path);
  if (!project) {
    await ctx.reply(`Project already exists: ${path}`);
    return;
  }

  await ctx.reply(`Added: ${project.name}\n${project.path}\n\nUse /projects to start it.`);

  // Trigger async project knowledge scan (non-blocking)
  const { scanProjectKnowledge } = await import("../../memory/project-scanner.ts");
  scanProjectKnowledge(project.path).catch((err) =>
    logger.error({ err, path: project.path }, "project-add: scan error")
  );
}
