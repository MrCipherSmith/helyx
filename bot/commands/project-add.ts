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

  let project = await projectService.create(name, path);
  let isNew = true;
  if (!project) {
    project = await projectService.getByPath(path);
    if (!project) {
      await replyInThread(ctx, `❌ Failed to get project: ${path}`);
      return;
    }
    isNew = false;
  }

  // FR-2: create forum topic if forum is configured; verify existing topic is alive
  const forumChatId = await forumService.getForumChatId();
  if (forumChatId) {
    const { sql } = await import("../../memory/db.ts");
    const topicRow = await sql`SELECT forum_topic_id FROM projects WHERE id = ${project.id}`;
    const existingTopicId = topicRow[0]?.forum_topic_id as number | null | undefined;

    // Verify existing topic is still alive in Telegram
    let topicAlive = false;
    if (existingTopicId) {
      try {
        await ctx.api.sendMessage(Number(forumChatId), `📌 ${project.name}`, {
          message_thread_id: existingTopicId,
        } as any);
        topicAlive = true;
      } catch {
        // Topic was deleted — clear stale ID and recreate below
        await sql`UPDATE projects SET forum_topic_id = NULL WHERE id = ${project.id}`;
        logger.info({ project: project.name, topicId: existingTopicId }, "project-add: stale forum_topic_id cleared");
      }
    }

    if (!topicAlive) {
      try {
        const allProjects = await sql`SELECT id FROM projects WHERE forum_topic_id IS NOT NULL`;
        const colorIndex = allProjects.length;
        const threadId = await forumService.createTopicForProject(ctx.api, forumChatId, project, colorIndex);
        await ctx.api.sendMessage(Number(forumChatId), `📁 ${project.name}\n${project.path}`, {
          message_thread_id: threadId,
        } as any);
        await replyInThread(ctx, isNew
          ? `Added: ${project.name}\n${project.path}\n\nUse /projects to start it.`
          : `✅ Forum topic recreated for: ${project.name}`
        );
      } catch (err) {
        logger.error({ err, project: project.name }, "project-add: failed to create forum topic");
        await replyInThread(ctx, isNew
          ? `Added: ${project.name}\n${project.path}\n\nUse /projects to start it.`
          : `Project already exists: ${path} (forum topic creation failed)`
        );
      }
    } else {
      await replyInThread(ctx, isNew
        ? `Added: ${project.name}\n${project.path}\n\nUse /projects to start it.`
        : `Project already exists: ${path} (forum topic already active)`
      );
    }
  } else {
    await replyInThread(ctx, isNew
      ? `Added: ${project.name}\n${project.path}\n\nUse /projects to start it.`
      : `Project already exists: ${path}`
    );
  }

  // Trigger async project knowledge scan (non-blocking)
  const { scanProjectKnowledge } = await import("../../memory/project-scanner.ts");
  scanProjectKnowledge(project.path).catch((err) =>
    logger.error({ err, path: project.path }, "project-add: scan error")
  );
}
