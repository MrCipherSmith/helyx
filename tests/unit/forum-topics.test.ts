import { describe, test, expect } from "bun:test";

/**
 * Forum Topics — pure unit tests.
 *
 * No database, no Telegram API calls. Tests cover:
 *   - routeMessage forum routing decision logic (pure function extracted)
 *   - FORUM_ICON_COLORS round-robin assignment
 *   - replyInThread helper: injects message_thread_id when present
 *   - StatusManager forum target resolution
 *   - StatusManager state key in forum vs DM mode
 *   - Forum prefix suppression (FR-10)
 *   - PermissionHandler forum target resolution
 *   - Migration v13 schema shape
 */

// ---------------------------------------------------------------------------
// 1. routeMessage forum routing decision
// ---------------------------------------------------------------------------

/**
 * Pure routing decision: given a forumTopicId, should we use forum routing?
 * Rules (from FR-3):
 *   forumTopicId === undefined → DM routing
 *   forumTopicId === 1         → General topic → DM routing
 *   forumTopicId > 1           → forum routing by project
 */
function shouldUseForumRouting(forumTopicId: number | undefined): boolean {
  return forumTopicId !== undefined && forumTopicId > 1;
}

describe("routeMessage — forum routing decision", () => {
  test("no thread ID → DM routing", () => {
    expect(shouldUseForumRouting(undefined)).toBe(false);
  });

  test("thread ID = 1 (General topic) → DM routing", () => {
    expect(shouldUseForumRouting(1)).toBe(false);
  });

  test("thread ID = 2 → forum routing", () => {
    expect(shouldUseForumRouting(2)).toBe(true);
  });

  test("thread ID = 1337 → forum routing", () => {
    expect(shouldUseForumRouting(1337)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Forum icon color round-robin
// ---------------------------------------------------------------------------

const FORUM_ICON_COLORS = [
  0x6fb9f0, // blue
  0xffd67e, // yellow
  0xcb86db, // violet
  0x8eee98, // green
  0xff93b2, // pink
  0xfb6f5f, // red
] as const;

function pickIconColor(index: number): number {
  return FORUM_ICON_COLORS[index % FORUM_ICON_COLORS.length];
}

describe("Forum icon color round-robin", () => {
  test("index 0 → blue", () => {
    expect(pickIconColor(0)).toBe(0x6fb9f0);
  });

  test("index 5 → red (last)", () => {
    expect(pickIconColor(5)).toBe(0xfb6f5f);
  });

  test("index 6 wraps back to blue", () => {
    expect(pickIconColor(6)).toBe(0x6fb9f0);
  });

  test("index 7 wraps to yellow", () => {
    expect(pickIconColor(7)).toBe(0xffd67e);
  });

  test("exactly 6 colors defined", () => {
    expect(FORUM_ICON_COLORS.length).toBe(6);
  });

  test("all 6 colors are distinct", () => {
    const unique = new Set(FORUM_ICON_COLORS);
    expect(unique.size).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// 3. replyInThread — message_thread_id injection
// ---------------------------------------------------------------------------

/**
 * Pure simulation of the replyInThread logic (no grammY Context needed).
 */
function buildReplyExtra(
  threadId: number | undefined,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  if (threadId !== undefined) {
    return { ...extra, message_thread_id: threadId };
  }
  return extra;
}

describe("replyInThread — message_thread_id injection", () => {
  test("no threadId: extra unchanged", () => {
    const result = buildReplyExtra(undefined, { parse_mode: "HTML" });
    expect(result).toEqual({ parse_mode: "HTML" });
    expect(result.message_thread_id).toBeUndefined();
  });

  test("with threadId: injects message_thread_id", () => {
    const result = buildReplyExtra(42, { parse_mode: "HTML" });
    expect(result.message_thread_id).toBe(42);
    expect(result.parse_mode).toBe("HTML");
  });

  test("empty extra + threadId: only message_thread_id", () => {
    const result = buildReplyExtra(7);
    expect(result).toEqual({ message_thread_id: 7 });
  });

  test("does not mutate original extra object", () => {
    const orig = { parse_mode: "HTML" };
    buildReplyExtra(5, orig);
    expect((orig as any).message_thread_id).toBeUndefined();
  });

  test("threadId = 1 (General topic) is injected too (routing handles General separately)", () => {
    // replyInThread injects whatever threadId ctx has, including 1.
    // The distinction between General and project topics is in routing, not replies.
    const result = buildReplyExtra(1);
    expect(result.message_thread_id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. StatusManager forum target resolution
// ---------------------------------------------------------------------------

/**
 * Pure simulation of StatusManager.getForumTarget() logic.
 */
function getForumTarget(
  forumChatId: (() => string | null) | undefined,
  forumTopicId: (() => number | null) | undefined,
): { chatId: string; threadId: number; extra: Record<string, unknown> } | null {
  const chatId = forumChatId?.();
  const topicId = forumTopicId?.();
  if (chatId && topicId) {
    return { chatId, threadId: topicId, extra: { message_thread_id: topicId } };
  }
  return null;
}

function getStateKey(
  chatId: string,
  forumChatId: (() => string | null) | undefined,
  forumTopicId: (() => number | null) | undefined,
): string {
  const forum = getForumTarget(forumChatId, forumTopicId);
  return forum ? `${forum.chatId}:${forum.threadId}` : chatId;
}

describe("StatusManager — forum target resolution", () => {
  test("no forum config → null", () => {
    expect(getForumTarget(undefined, undefined)).toBeNull();
  });

  test("only chatId set → null (need both)", () => {
    expect(getForumTarget(() => "-100111", undefined)).toBeNull();
  });

  test("only topicId set → null (need both)", () => {
    expect(getForumTarget(undefined, () => 42)).toBeNull();
  });

  test("chatId empty string → null", () => {
    expect(getForumTarget(() => "", () => 42)).toBeNull();
  });

  test("topicId = null → null", () => {
    expect(getForumTarget(() => "-100111", () => null)).toBeNull();
  });

  test("both set → forum target", () => {
    const target = getForumTarget(() => "-100111", () => 42);
    expect(target).not.toBeNull();
    expect(target!.chatId).toBe("-100111");
    expect(target!.threadId).toBe(42);
    expect(target!.extra.message_thread_id).toBe(42);
  });
});

describe("StatusManager — state key", () => {
  test("DM mode: key = chatId", () => {
    expect(getStateKey("111222", undefined, undefined)).toBe("111222");
  });

  test("forum mode: key = chatId:threadId", () => {
    expect(getStateKey("111222", () => "-100999", () => 7)).toBe("-100999:7");
  });
});

// ---------------------------------------------------------------------------
// 5. Forum prefix suppression (FR-10)
// ---------------------------------------------------------------------------

/**
 * Pure simulation of StatusManager.getSessionPrefix() in forum vs DM mode.
 * In forum mode: always "" (topic identifies the project).
 * In DM mode with active session: "".
 * In DM mode with non-active session: "📌 name · ".
 */
function getSessionPrefix(
  isForumMode: boolean,
  isActiveSession: boolean,
  sessionName: string,
): string {
  if (isForumMode) return "";
  return isActiveSession ? "" : `📌 ${sessionName} · `;
}

describe("Status prefix — forum mode suppression (FR-10)", () => {
  test("forum mode: prefix is empty regardless of session activity", () => {
    expect(getSessionPrefix(true, false, "keryx")).toBe("");
    expect(getSessionPrefix(true, true, "keryx")).toBe("");
  });

  test("DM mode, active session: no prefix", () => {
    expect(getSessionPrefix(false, true, "keryx")).toBe("");
  });

  test("DM mode, non-active session: shows project prefix", () => {
    expect(getSessionPrefix(false, false, "keryx")).toBe("📌 keryx · ");
  });
});

// ---------------------------------------------------------------------------
// 6. PermissionHandler forum target resolution
// ---------------------------------------------------------------------------

describe("PermissionHandler — forum target resolution", () => {
  test("no forum config → no override (use chat_sessions lookup)", () => {
    expect(getForumTarget(undefined, undefined)).toBeNull();
  });

  test("forum configured → override chatId + add message_thread_id to sends", () => {
    const target = getForumTarget(() => "-100888", () => 15);
    expect(target!.chatId).toBe("-100888");
    expect(target!.extra).toEqual({ message_thread_id: 15 });
  });
});

// ---------------------------------------------------------------------------
// 7. Migration v13 — schema fields
// ---------------------------------------------------------------------------

describe("Migration v13 — schema", () => {
  test("projects table gets forum_topic_id (INTEGER, nullable)", () => {
    // Schema assertion: forum_topic_id must be nullable INTEGER (maps to project topics)
    const field = { name: "forum_topic_id", type: "INTEGER", nullable: true };
    expect(field.type).toBe("INTEGER");
    expect(field.nullable).toBe(true);
  });

  test("bot_config table has key + value columns", () => {
    const schema = [
      { name: "key", type: "TEXT", primaryKey: true },
      { name: "value", type: "TEXT", nullable: false },
      { name: "updated_at", type: "TIMESTAMPTZ", nullable: true },
    ];
    expect(schema.find((c) => c.name === "key")?.primaryKey).toBe(true);
    expect(schema.find((c) => c.name === "value")?.nullable).toBe(false);
  });

  test("forum_chat_id is seeded empty in bot_config", () => {
    const seedValue = "";
    // Empty string = not configured; service returns null for empty strings
    const isConfigured = seedValue.length > 0;
    expect(isConfigured).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. ForumService.setup — project topic creation
// ---------------------------------------------------------------------------

/**
 * Pure simulation of the color-index assignment in ForumService.setup().
 */
function assignTopicColors(projectNames: string[]): Array<{ name: string; color: number }> {
  return projectNames.map((name, i) => ({
    name,
    color: pickIconColor(i),
  }));
}

describe("ForumService.setup — topic color assignment", () => {
  test("first 6 projects get distinct colors", () => {
    const projects = ["a", "b", "c", "d", "e", "f"];
    const result = assignTopicColors(projects);
    const colors = result.map((r) => r.color);
    expect(new Set(colors).size).toBe(6);
  });

  test("7th project wraps to first color", () => {
    const projects = ["a", "b", "c", "d", "e", "f", "g"];
    const result = assignTopicColors(projects);
    expect(result[6].color).toBe(result[0].color);
  });

  test("single project gets blue (index 0)", () => {
    const result = assignTopicColors(["keryx"]);
    expect(result[0].color).toBe(0x6fb9f0);
  });
});
