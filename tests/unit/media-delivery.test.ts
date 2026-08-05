/**
 * What happens to a file after it has been downloaded.
 *
 * `bot/media.ts` was 5.59% covered, and `deliverMedia` is its fork in the road:
 * a file that arrived goes either into a CLI session's queue, as a message
 * carrying an attachment, or into a standalone chat, where an image is inlined
 * into the prompt and anything else is acknowledged.
 *
 * That branch has been wrong in a way that mattered. A document arriving as
 * `image/png` was inlined for one path and not for the other, and one of the
 * two had no size limit at all, so a forty-megabyte picture went into a request
 * whole. The decision about *what* may be inlined was extracted to
 * `utils/media-attachment.ts` and tested there; the code that acts on the
 * answer was not tested anywhere.
 *
 * Nothing here replaces a module. The first version did — nine of them, then
 * five — and every arrangement of it broke four tests in
 * `reviewer-service.test.ts` and one migration test, because replacing
 * `memory/db.ts` re-evaluates the graph behind `bot/media.ts`, which is most of
 * the bot, and left `services/provider-service.ts` half-initialised for
 * whatever ran next. The seam in `media.ts` exists for that reason, and it is
 * put back after each test.
 *
 * The files on disk are real, because the size guard reads bytes off a disk and
 * a fake that reported its own length would be testing itself.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import type { Bot, Context } from "grammy";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { FakeSql } from "../fixtures/fake-sql.ts";
import { IMAGE_INLINE_MAX_BYTES } from "../../utils/media-attachment.ts";
import { deliverMedia, setMediaDeps, type MediaDeps } from "../../bot/media.ts";

/** Everything the delivery did that did not go through the database. */
interface Seen {
  streamed: Array<{ system: string; messages: unknown[] }>;
  replies: string[];
  voiced: string[];
  logs: Array<{ stage: string; message: string; level: string }>;
}

let seen: Seen;
let db: FakeSql;
let restore: (() => void) | undefined;
let dir: string;

/** A picture small enough to travel as bytes, and one that is not. */
let smallImage: string;
let hugeImage: string;
let document: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "helyx-media-"));
  smallImage = join(dir, "screenshot.png");
  hugeImage = join(dir, "enormous.png");
  document = join(dir, "report.pdf");
  await Bun.write(smallImage, new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
  // One byte over the line the guard draws, so it is the guard being tested and
  // not a number near it.
  await Bun.write(hugeImage, new Uint8Array(IMAGE_INLINE_MAX_BYTES + 1));
  await Bun.write(document, new Uint8Array([0x25, 0x50, 0x44, 0x46]));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A chat that records what was said in it. */
function context(): Context {
  return {
    chat: { id: -100777 },
    from: { id: 1, username: "operator" },
    message: { message_id: 4242 },
    reply: async (text: string) => { seen.replies.push(text); return { message_id: 1 }; },
  } as unknown as Context;
}

function route(mode: "cli" | "standalone") {
  return {
    mode,
    sessionId: 7,
    projectPath: mode === "cli" ? "/home/altsay/bots/helyx" : null,
  } as unknown as Awaited<ReturnType<typeof import("../../sessions/router.ts").routeMessage>>;
}

function install(provider = "anthropic"): void {
  restore?.();
  seen = { streamed: [], replies: [], voiced: [], logs: [] };
  db = new FakeSql();

  const stubs: Partial<MediaDeps> = {
    sql: db.sql as unknown as MediaDeps["sql"],
    getBotRef: () => ({ api: {} }) as unknown as Bot,
    getProviderInfo: (() => ({ provider, model: "claude-opus-5" })) as unknown as MediaDeps["getProviderInfo"],
    // Recorded through the same fake `sql` the queue write goes to, so the
    // order the two happen in is visible rather than assumed.
    addMessage: (async (m: { role: string; content: string; metadata?: unknown }) => {
      await db.sql`INSERT INTO messages (role, content, metadata) VALUES (${m.role}, ${m.content}, ${JSON.stringify(m.metadata ?? {})})`;
    }) as unknown as MediaDeps["addMessage"],
    composePrompt: (async (_s: number, _c: string, text: string) => ({
      system: "you are helyx",
      messages: [{ role: "user", content: text }],
    })) as unknown as MediaDeps["composePrompt"],
    streamToTelegram: (async (_bot: unknown, _chat: number, system: string, messages: unknown[]) => {
      seen.streamed.push({ system, messages });
      return "that is a screenshot of a failing test";
    }) as unknown as MediaDeps["streamToTelegram"],
    maybeAttachVoice: ((_bot: unknown, _chat: number, text: string) => { seen.voiced.push(text); }) as unknown as MediaDeps["maybeAttachVoice"],
    appendLog: (async (_s: number | null, _c: string, stage: string, message: string, level = "info") => {
      seen.logs.push({ stage, message, level });
    }) as unknown as MediaDeps["appendLog"],
  };

  restore = setMediaDeps(stubs);
}

beforeEach(() => { install(); });
afterEach(() => { restore?.(); restore = undefined; });

/** The attachments column of the queue insert, as JSON. */
function queuedAttachments(): Array<Record<string, any>> {
  const queued = db.matching("message_queue");
  expect(queued).toHaveLength(1);
  const raw = queued[0]!.values.find((v) => typeof v === "string" && v.startsWith("[")) as string;
  return JSON.parse(raw);
}

/** The messages written to the session's own history, in order. */
function history(): Array<{ role: string; content: string; metadata: Record<string, unknown> }> {
  return db.matching("INSERT INTO messages").map((q) => ({
    role: q.values[0] as string,
    content: q.values[1] as string,
    metadata: JSON.parse(q.values[2] as string),
  }));
}

describe("a file delivered to a CLI session", () => {
  test("is queued with its attachment and its message id, and no model is called", async () => {
    await deliverMedia(
      context(), route("cli"), smallImage, "/host/screenshot.png",
      "Photo", "what is wrong here", "file-1", "screenshot.png", "image/png", 4242, null,
    );

    // The session sees the file in its own history...
    expect(history()).toHaveLength(1);
    expect(history()[0]!.content).toContain("/host/screenshot.png");
    expect(history()[0]!.metadata).toMatchObject({ fileId: "file-1", messageId: 4242 });

    // ...and it is queued for the session to pick up, carrying the picture.
    const [attachment] = queuedAttachments();
    expect(attachment).toMatchObject({ type: "image", mime: "image/png", path: "/host/screenshot.png" });
    expect(attachment!.base64).toBeTruthy();

    // Nothing was asked of a model: the session will do the looking.
    expect(seen.streamed).toHaveLength(0);
    expect(seen.replies).toHaveLength(0);
  });

  test("an over-large picture is queued as a path rather than as bytes", async () => {
    // The guard that a forty-megabyte photo once walked straight past.
    await deliverMedia(
      context(), route("cli"), hugeImage, "/host/enormous.png",
      "Photo", "", "file-2", "enormous.png", "image/png", 4243, null,
    );

    const [attachment] = queuedAttachments();
    expect(attachment).toMatchObject({ type: "image", path: "/host/enormous.png" });
    expect(attachment!.base64).toBeUndefined();
  });

  test("a video is queued as a file, and its bytes are never read", async () => {
    // The order the question is asked in: pulling a 40 MB video into memory to
    // decide it is not an image is what asking it the wrong way round costs. A
    // path that does not exist is how the test proves nothing opened it — the
    // delivery reads bytes only inside `if (isImage(facts))`, and if that guard
    // were ever removed, or a `stat` added ahead of it, this line would throw
    // ENOENT instead of quietly passing. Raised in review as a test that could
    // not pass; it passes, and the reason it passes is the guard.
    await deliverMedia(
      context(), route("cli"), join(dir, "never-opened.mp4"), "/host/clip.mp4",
      "Video", "have a look", "file-3", "clip.mp4", "video/mp4", 4244, null,
    );

    const [attachment] = queuedAttachments();
    expect(attachment).toMatchObject({ type: "file", path: "/host/clip.mp4", name: "clip.mp4" });
  });
});

describe("a file delivered to a standalone chat", () => {
  test("an image is inlined into the prompt and the answer comes back", async () => {
    await deliverMedia(
      context(), route("standalone"), smallImage, "/host/screenshot.png",
      "Photo", "what is wrong here", "file-4", "screenshot.png", "image/png", 4245, null,
    );

    expect(seen.streamed).toHaveLength(1);
    const blocks = (seen.streamed[0]!.messages.at(-1) as { content: Array<Record<string, any>> }).content;
    const image = blocks.find((b) => b.type === "image");
    expect(image).toBeTruthy();
    expect(image!.source.media_type).toBe("image/png");
    expect(image!.source.data).toBeTruthy();
    expect(blocks.find((b) => b.type === "text")!.text).toContain("what is wrong here");

    // The answer is kept and offered as voice, as any other answer would be.
    expect(history().map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(seen.voiced).toHaveLength(1);
    expect(seen.replies).toHaveLength(0);
  });

  test("anything that is not an image is acknowledged, not inlined", async () => {
    await deliverMedia(
      context(), route("standalone"), document, "/host/report.pdf",
      "Document", "have a look", "file-5", "report.pdf", "application/pdf", 4246, null,
    );

    expect(seen.streamed).toHaveLength(0);
    expect(seen.replies).toHaveLength(1);
    expect(seen.replies[0]).toContain("Document");
    expect(seen.replies[0]).toContain("File saved");
  });

  test("an image too large to inline is acknowledged rather than dropped", async () => {
    // The failure that matters is the silent one: the operator sent a file and
    // heard nothing back at all.
    await deliverMedia(
      context(), route("standalone"), hugeImage, "/host/enormous.png",
      "Photo", "", "file-6", "enormous.png", "image/png", 4247, null,
    );

    expect(seen.streamed).toHaveLength(0);
    expect(seen.logs.some((l) => l.level === "error" && l.message.includes("image too large"))).toBe(true);
    expect(seen.replies).toHaveLength(1);
    expect(seen.replies[0]).toContain("File saved");
  });

  test("a provider that cannot look at pictures gets the acknowledgement, not a broken request", async () => {
    // Only Anthropic takes an inline image block here; sending one to a
    // provider that does not is a request that fails rather than an answer.
    install("deepseek");

    await deliverMedia(
      context(), route("standalone"), smallImage, "/host/screenshot.png",
      "Photo", "what is wrong here", "file-7", "screenshot.png", "image/png", 4248, null,
    );

    expect(seen.streamed).toHaveLength(0);
    expect(seen.replies[0]).toContain("File saved");
  });
});
