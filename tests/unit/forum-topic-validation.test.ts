import { describe, test, expect } from "bun:test";
import type { Api } from "grammy";
import { forumService } from "../../services/forum-service.ts";

/**
 * `validateTopicExists` — drives the real method against a recording stand-in
 * for grammY's `Api`.
 *
 * The check this replaced used `sendChatAction`, which Telegram answers `ok` for
 * a thread id that never existed. Every topic therefore validated, `/forum_clean`
 * had nothing to clean, and a project whose topic had been deleted kept a live
 * `forum_topic_id` while its answers went to General. The distinction the tests
 * below encode is the one Telegram actually makes: a live topic echoes
 * `message_thread_id` back on a real message, a deleted one does not.
 */

interface Probe {
  chatId: number;
  text: string;
  extra: Record<string, unknown>;
}

function fakeApi(opts: {
  onSend: (chatId: number, extra: Record<string, unknown>) => any;
}): { api: Api; probes: Probe[]; deletes: Array<{ chatId: number; messageId: number }> } {
  const probes: Probe[] = [];
  const deletes: Array<{ chatId: number; messageId: number }> = [];
  const api = {
    sendMessage: async (chatId: number, text: string, extra: Record<string, unknown> = {}) => {
      probes.push({ chatId, text, extra });
      return opts.onSend(chatId, extra);
    },
    deleteMessage: async (chatId: number, messageId: number) => {
      deletes.push({ chatId, messageId });
      return true;
    },
  } as unknown as Api;
  return { api, probes, deletes };
}

describe("ForumService.validateTopicExists", () => {
  test("live topic — Telegram echoes the thread back → valid", async () => {
    const { api, probes, deletes } = fakeApi({
      onSend: (_chatId, extra) => ({
        message_id: 900,
        message_thread_id: extra.message_thread_id,
        is_topic_message: true,
      }),
    });

    expect(await forumService.validateTopicExists(api, "-100123", 1158)).toBe(true);
    expect(probes[0].extra.message_thread_id).toBe(1158);
    expect(deletes).toEqual([{ chatId: -100123, messageId: 900 }]);
  });

  test("deleted topic — accepted without a thread, lands in General → invalid", async () => {
    // The exact shape Telegram returned for the deleted keryx topic: ok, a
    // message id, and no message_thread_id at all.
    const { api, deletes } = fakeApi({
      onSend: () => ({ message_id: 901 }),
    });

    expect(await forumService.validateTopicExists(api, "-100123", 1159)).toBe(false);
    // The probe still exists — in General — and has to be cleaned up regardless.
    expect(deletes).toEqual([{ chatId: -100123, messageId: 901 }]);
  });

  test("a different thread in the reply is not a pass", async () => {
    const { api } = fakeApi({
      onSend: () => ({ message_id: 902, message_thread_id: 1, is_topic_message: true }),
    });

    expect(await forumService.validateTopicExists(api, "-100123", 1159)).toBe(false);
  });

  test("explicit thread-not-found error → invalid, nothing to clean up", async () => {
    const { api, deletes } = fakeApi({
      onSend: () => {
        throw new Error("Bad Request: message thread not found");
      },
    });

    expect(await forumService.validateTopicExists(api, "-100123", 999999)).toBe(false);
    expect(deletes).toEqual([]);
  });

  test("unrelated failure → assumed valid, so /forum_clean cannot erase a live mapping", async () => {
    const { api } = fakeApi({
      onSend: () => {
        throw new Error("Too Many Requests: retry after 12");
      },
    });

    expect(await forumService.validateTopicExists(api, "-100123", 1158)).toBe(true);
  });
});
