/**
 * ForumService — manages Telegram Forum Supergroup topics per project.
 *
 * Responsibilities:
 *   - store/load forum_chat_id in bot_config
 *   - create/sync Telegram topics for projects
 *   - map forum_topic_id ↔ project
 */

import type { Api } from "grammy";
import { sql } from "../memory/db.ts";
import { logger } from "../logger.ts";

/** 6 predefined Telegram topic icon colors (RGB integers). */
export const FORUM_ICON_COLORS = [
  0x6fb9f0, // blue
  0xffd67e, // yellow
  0xcb86db, // violet
  0x8eee98, // green
  0xff93b2, // pink
  0xfb6f5f, // red
] as const;

export interface ForumProject {
  id: number;
  name: string;
  forum_topic_id: number | null;
}

export class ForumService {
  // --- bot_config helpers ---

  async getForumChatId(): Promise<string | null> {
    const rows = await sql`SELECT value FROM bot_config WHERE key = 'forum_chat_id'`;
    const val = rows[0]?.value as string | undefined;
    return val && val.length > 0 ? val : null;
  }

  async setForumChatId(chatId: string): Promise<void> {
    await sql`
      INSERT INTO bot_config (key, value) VALUES ('forum_chat_id', ${chatId})
      ON CONFLICT (key) DO UPDATE SET value = ${chatId}, updated_at = now()
    `;
  }

  async setProjectForumTopicId(projectId: number, topicId: number): Promise<void> {
    await sql`UPDATE projects SET forum_topic_id = ${topicId} WHERE id = ${projectId}`;
  }

  async getForumTopicIdForProject(projectPath: string): Promise<number | null> {
    const rows = await sql`SELECT forum_topic_id FROM projects WHERE path = ${projectPath}`;
    return (rows[0]?.forum_topic_id as number | null) ?? null;
  }

  // --- Topic lifecycle ---

  /**
   * Create a Telegram forum topic for a project.
   * Returns the new message_thread_id.
   */
  async createTopicForProject(
    api: Api,
    forumChatId: string | number,
    project: { id: number; name: string },
    colorIndex: number,
  ): Promise<number> {
    const color = FORUM_ICON_COLORS[colorIndex % FORUM_ICON_COLORS.length];
    const topic = await api.createForumTopic(Number(forumChatId), project.name, {
      icon_color: color,
    });
    const threadId = topic.message_thread_id;
    await this.setProjectForumTopicId(project.id, threadId);
    logger.info({ project: project.name, threadId }, "forum topic created");
    return threadId;
  }

  /**
   * `/forum_setup` — configure forum and create topics for all existing projects.
   */
  async setup(
    api: Api,
    chatId: string,
  ): Promise<{ topicsCreated: number; errors: string[] }> {
    await this.setForumChatId(chatId);

    const projects = await sql`
      SELECT id, name FROM projects WHERE forum_topic_id IS NULL ORDER BY name
    ` as unknown as Array<{ id: number; name: string }>;

    let topicsCreated = 0;
    const errors: string[] = [];

    for (let i = 0; i < projects.length; i++) {
      const project = projects[i];
      try {
        await this.createTopicForProject(api, chatId, project, i);
        topicsCreated++;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        logger.error({ err, project: project.name }, "failed to create forum topic");
        errors.push(`${project.name}: ${msg}`);
      }
    }

    return { topicsCreated, errors };
  }

  /**
   * `/forum_sync` — create missing topics, close topics for deleted projects.
   */
  async sync(
    api: Api,
    chatId: string,
  ): Promise<{ created: number; closed: number; errors: string[] }> {
    const projects = await sql`
      SELECT id, name, forum_topic_id FROM projects ORDER BY name
    ` as unknown as ForumProject[];

    const missing = projects.filter((p) => p.forum_topic_id === null);
    const existing = projects.filter((p) => p.forum_topic_id !== null);
    const existingTopicIds = new Set(existing.map((p) => p.forum_topic_id!));

    // Count of topics in forum that don't match any project
    // (we can't enumerate all topics, so we only close known orphan topics from DB)
    // For now: create missing, skip closing (Telegram API doesn't list topics)

    let created = 0;
    let closed = 0;
    const errors: string[] = [];

    // Create topics for projects without one
    const offset = existing.length; // continue color rotation after existing
    for (let i = 0; i < missing.length; i++) {
      const project = missing[i];
      try {
        await this.createTopicForProject(api, chatId, project, offset + i);
        created++;
      } catch (err: any) {
        errors.push(`${project.name}: ${err?.message ?? String(err)}`);
      }
    }

    return { created, closed, errors };
  }
}

export const forumService = new ForumService();
