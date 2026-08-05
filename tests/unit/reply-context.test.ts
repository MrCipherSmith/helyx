import { describe, expect, test } from "bun:test";
import {
  extractReplyContext,
  renderReplyContext,
  replyAuthor,
  replyMedia,
  MAX_QUOTE,
  MAX_TEXT,
} from "../../utils/reply-context.ts";

describe("extractReplyContext", () => {
  test("an ordinary message is not a reply", () => {
    expect(extractReplyContext({})).toBeNull();
    expect(extractReplyContext(undefined)).toBeNull();
    expect(extractReplyContext(null)).toBeNull();
  });

  test("carries the answered message, its author and its id", () => {
    const context = extractReplyContext({
      reply_to_message: {
        message_id: 54160,
        text: "Docker compose поднимает два контейнера",
        from: { first_name: "Helyx", is_bot: true },
      },
    });

    expect(context).toEqual({
      messageId: 54160,
      author: "Helyx",
      fromBot: true,
      text: "Docker compose поднимает два контейнера",
    });
  });

  test("a hand-picked fragment is kept alongside the message it came from", () => {
    const context = extractReplyContext({
      reply_to_message: { message_id: 7, text: "первая строка\nвторая строка", from: { first_name: "Helyx" } },
      quote: { text: "вторая строка" },
    });

    expect(context?.quote).toBe("вторая строка");
    expect(context?.text).toBe("первая строка\nвторая строка");
  });

  test("a caption stands in for text, so replying to a photo still says something", () => {
    const context = extractReplyContext({
      reply_to_message: { message_id: 3, caption: "скрин с ошибкой", photo: [{}] },
    });

    expect(context?.text).toBe("скрин с ошибкой");
    expect(context?.media).toBeUndefined();
  });

  test("a wordless message is named by what it was", () => {
    const context = extractReplyContext({
      reply_to_message: { message_id: 3, voice: {}, from: { first_name: "Helyx" } },
    });

    expect(context).toEqual({ messageId: 3, author: "Helyx", media: "voice message" });
  });

  // Both limits exist because a reply to a long message would otherwise re-inject
  // the whole of it in front of every question about it.
  test("a long message is truncated rather than carried whole", () => {
    const context = extractReplyContext({
      reply_to_message: { message_id: 1, text: "x".repeat(MAX_TEXT + 500) },
    });

    expect(context?.text).toHaveLength(MAX_TEXT + 1); // + the ellipsis
    expect(context?.text?.endsWith("…")).toBe(true);
  });

  test("a long fragment is truncated too", () => {
    const context = extractReplyContext({
      reply_to_message: { message_id: 1, text: "short" },
      quote: { text: "y".repeat(MAX_QUOTE + 10) },
    });

    expect(context?.quote).toHaveLength(MAX_QUOTE + 1);
  });

  // Telegram attaches the topic-created service message as a reply to the first
  // message posted in a forum topic. Quoting "topic created" back at the session
  // would be noise on the opening line of every new topic.
  test("the forum topic-created service message is not a reply", () => {
    const context = extractReplyContext({
      reply_to_message: { message_id: 3310, forum_topic_created: { name: "helyx" } },
      quote: { text: "helyx" },
    });

    expect(context).toBeNull();
  });

  test("a reply to another chat keeps the fragment, which is all Telegram sends", () => {
    const context = extractReplyContext({
      quote: { text: "цитата из другого чата" },
      external_reply: { message_id: 99 },
    });

    expect(context).toEqual({ quote: "цитата из другого чата", messageId: 99 });
  });

  test("a reply with nothing in it is not worth a block", () => {
    expect(extractReplyContext({ reply_to_message: { message_id: 5 } })).toBeNull();
  });
});

describe("replyAuthor", () => {
  test("first and last name read as one name", () => {
    expect(replyAuthor({ from: { first_name: "Aleksandr", last_name: "Tsaitler" } })).toBe("Aleksandr Tsaitler");
  });

  test("a username stands in when there is no name", () => {
    expect(replyAuthor({ from: { username: "altsay" } })).toBe("altsay");
  });

  // A message posted as the group reports a generic anonymous-admin account in
  // `from`; naming that would be worse than naming nobody.
  test("the group's own name wins over the anonymous admin behind it", () => {
    expect(replyAuthor({
      sender_chat: { title: "GoodDev Hub" },
      from: { first_name: "Group" },
    })).toBe("GoodDev Hub");
  });

  test("an author Telegram did not send is nobody", () => {
    expect(replyAuthor({})).toBeUndefined();
  });
});

describe("replyMedia", () => {
  test("a video note is not reported as a video", () => {
    expect(replyMedia({ video_note: {} })).toBe("video note");
  });

  test("nothing attached is nothing to name", () => {
    expect(replyMedia({ text: "hi" })).toBeUndefined();
  });
});

describe("renderReplyContext", () => {
  test("no reply renders nothing, so the prefix vanishes for ordinary messages", () => {
    expect(renderReplyContext(null)).toBe("");
    expect(renderReplyContext(undefined)).toBe("");
  });

  test("the answered message is quoted line by line", () => {
    const out = renderReplyContext({ messageId: 12, author: "Helyx", text: "a\nb" });

    expect(out).toContain("replying to Helyx's message 12");
    expect(out).toContain("> a\n> b");
  });

  test("our own messages are named as ours, so the session knows who it is answering", () => {
    const out = renderReplyContext({ messageId: 12, author: "Helyx", fromBot: true, text: "a" });

    expect(out).toContain("Helyx (this bot)");
  });

  // The point of selecting a few words out of a long message is to point at
  // them; re-quoting the whole thing first would bury what was pointed at.
  test("a fragment leads, and the message it came from follows it", () => {
    const out = renderReplyContext({ messageId: 12, author: "Helyx", text: "one\ntwo", quote: "two" });

    expect(out.indexOf("> two")).toBeLessThan(out.indexOf("The full message"));
    expect(out).toContain("selected this fragment");
  });

  test("a fragment that is the whole message is not printed twice", () => {
    const out = renderReplyContext({ messageId: 12, author: "Helyx", text: "same", quote: "same" });

    expect(out).not.toContain("The full message");
  });

  test("a wordless message is described instead of quoted", () => {
    const out = renderReplyContext({ messageId: 4, author: "altsay", media: "photo" });

    expect(out).toContain("altsay's photo");
    expect(out).not.toContain(">");
  });

  test("every rendering ends in a newline, so it cannot run into the user's words", () => {
    for (const context of [
      { text: "a" },
      { quote: "a" },
      { media: "photo" },
    ]) {
      expect(renderReplyContext(context).endsWith("\n")).toBe(true);
    }
  });
});
