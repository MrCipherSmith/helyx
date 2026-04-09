import type { Context } from "grammy";
import { join } from "path";
import { existsSync } from "fs";
import { setPendingInput } from "../handlers.ts";
import { projectService } from "../../services/project-service.ts";
import { forumService } from "../../services/forum-service.ts";
import { CONFIG } from "../../config.ts";
import { logger } from "../../logger.ts";
import { replyInThread } from "../format.ts";

const HOST_HOME = process.env.HOST_HOME ?? "";

/** Convert a host-side absolute path to the container-visible path for existence checks. */
function toContainerPath(hostPath: string): string {
  if (HOST_HOME && hostPath.startsWith(HOST_HOME)) {
    return "/host-home" + hostPath.slice(HOST_HOME.length);
  }
  return hostPath;
}

export async function handleProjectAdd(ctx: Context): Promise<void> {
  const text = ctx.message?.text ?? "";
  const arg = text.replace(/^\/project[_-]add\s*/, "").trim();

  if (arg) {
    await addProject(ctx, arg);
  } else {
    const chatId = String(ctx.chat!.id);
    const hostProjects = CONFIG.HOST_PROJECTS_DIR ?? "/home/user";
    await replyInThread(ctx, `Enter project path:\ne.g. ${join(hostProjects, "my-project")}`);
    setPendingInput(chatId, async (replyCtx) => {
      const path = replyCtx.message?.text?.trim() ?? "";
      await addProject(replyCtx, path);
    });
  }
}

async function addProject(ctx: Context, path: string): Promise<void> {
  if (!path.startsWith("/")) {
    await replyInThread(ctx, "Path must be absolute (start with /).");
    return;
  }

  const containerPath = toContainerPath(path);
  if (!existsSync(containerPath)) {
    await replyInThread(ctx, `❌ Path not found: ${path}`);
    return;
  }

  const name = path.split("/").pop() ?? path;

  const project = await projectService.create(name, path);
  if (!project) {
    await replyInThread(ctx, `Project already exists: ${path}`);
    return;
  }

  await replyInThread(ctx, `Added: ${project.name}\n${project.path}\n\nUse /projects to start it.`);

  // FR-2: create forum topic if forum is configured
  const forumChatId = await forumService.getForumChatId();
  if (forumChatId) {
    try {
      const allProjects = await import("../../memory/db.ts").then(({ sql }) =>
        sql`SELECT id FROM projects WHERE forum_topic_id IS NOT NULL`
      );
      const colorIndex = allProjects.length; // continue round-robin after existing topics
      const threadId = await forumService.createTopicForProject(ctx.api, forumChatId, project, colorIndex);
      // Send welcome message in the new topic
      await ctx.api.sendMessage(Number(forumChatId), `📁 ${project.name}\n${project.path}`, {
        message_thread_id: threadId,
      } as any);
    } catch (err) {
      logger.error({ err, project: project.name }, "project-add: failed to create forum topic");
    }
  }

  // Trigger async project knowledge scan (non-blocking)
  const { scanProjectKnowledge } = await import("../../memory/project-scanner.ts");
  scanProjectKnowledge(project.path).catch((err) =>
    logger.error({ err, path: project.path }, "project-add: scan error")
  );
}
