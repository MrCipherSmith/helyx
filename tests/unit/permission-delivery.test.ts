/**
 * How many messages a permission request arrives as.
 *
 * One, when the change fits — because the change and the question it is asking
 * about are one thought, and reading them in two messages meant reading them on
 * two screens. Two, when it does not, because Telegram refuses an oversized
 * message rather than trimming it, and a prompt that never arrives is worse
 * than a prompt in two parts.
 *
 * The split is the fallback now rather than the default, which is the whole
 * change; both halves of that sentence are asserted here.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PermissionHandler } from "../../channel/permissions.ts";
import { makePermissionWorld } from "../fixtures/fake-permission-ctx.ts";
import { installFakeTelegram, type FakeTelegram } from "../fixtures/fake-telegram.ts";
import { TELEGRAM_MESSAGE_MAX } from "../../utils/permission-message.ts";

const CHAT_ID = "555";
const REQUEST_ID = "req-1";

const ANSWER_QUERY = "SELECT response FROM permission_requests";
const STILL_OPEN_QUERY = "SELECT 1 FROM permission_requests";
const DEDUP_QUERY = "SELECT id FROM permission_requests";

let telegram: FakeTelegram;
let restoreTelegram: () => void;

beforeEach(async () => {
  ({ telegram, restore: restoreTelegram } = await installFakeTelegram());
});

afterEach(() => {
  restoreTelegram();
});

function answeredWorld() {
  const world = makePermissionWorld({ permissionTimeoutMs: 600 });
  world.db.program(DEDUP_QUERY, { rows: [] });
  world.db.program("SELECT chat_id FROM chat_sessions", { rows: [{ chat_id: CHAT_ID }] });
  world.db.program(STILL_OPEN_QUERY, { rows: [{ "?column?": 1 }] });
  world.db.program(ANSWER_QUERY, { rows: [{ response: "allow" }] });
  return world;
}

/** An Edit whose old/new strings become the change block. */
function editParams(oldStr: string, newStr: string) {
  return {
    request_id: REQUEST_ID,
    tool_name: "Edit",
    description: "update the migration",
    input: {
      file_path: "/home/altsay/bots/helyx/memory/db.ts",
      old_string: oldStr,
      new_string: newStr,
    },
  };
}

async function run(world: ReturnType<typeof answeredWorld>, params: unknown) {
  await new PermissionHandler(world.ctx as never, world.status.asStatusManager()).handle(params as never);
}

describe("an ordinary edit", () => {
  test("arrives as one message carrying the change and the buttons", async () => {
    const world = answeredWorld();
    await run(world, editParams("DROP TABLE message_queue", "ALTER TABLE message_queue"));

    expect(telegram.sent).toHaveLength(1);
    const [msg] = telegram.sent;
    expect(msg!.text).toContain("🔐 Allow?");
    expect(msg!.text).toContain("memory/db.ts");
    expect(msg!.text).toContain("DROP TABLE message_queue");
    expect(msg!.text).toContain("<pre><code");
    expect((msg!.extra as { reply_markup?: { inline_keyboard: unknown[] } })?.reply_markup?.inline_keyboard)
      .toHaveLength(1);
  });

  test("names the file the same way once, not two ways twice", async () => {
    const world = answeredWorld();
    await run(world, editParams("a", "b"));

    expect(telegram.texts().join("\n")).not.toContain("/home/altsay");
  });

  test("stores the body it rendered, so the answer can keep it", async () => {
    const world = answeredWorld();
    await run(world, editParams("a", "b"));

    expect(world.db.count("INSERT INTO permission_requests")).toBe(1);
  });
});

describe("a change too large for one message", () => {
  test("falls back to the preview message and the prompt", async () => {
    const world = answeredWorld();
    // Ampersands, not letters. The change is capped well under Telegram's limit
    // before escaping; it is the escaping that pushes it over, which is why the
    // fit is measured on the rendered html and not on the text it came from.
    const huge = "&".repeat(2000);
    await run(world, editParams(huge, huge));

    expect(telegram.sent.length).toBe(2);
    const [preview, prompt] = telegram.sent;
    expect(preview!.text).toContain("<pre><code");
    expect(prompt!.text).toContain("🔐 Allow?");
    // The change is in the preview and not repeated in the prompt: it arrived
    // once, and a prompt that fell back because it was too long is not the
    // place to put the thing that made it too long.
    expect(prompt!.text).not.toContain("<pre><code");
    expect(prompt!.text.length).toBeLessThanOrEqual(TELEGRAM_MESSAGE_MAX);
  });
});

describe("the message left behind", () => {
  test("a timeout keeps the change and clears the keyboard", async () => {
    const world = makePermissionWorld({ permissionTimeoutMs: 600 });
    world.db.program(DEDUP_QUERY, { rows: [] });
    world.db.program("SELECT chat_id FROM chat_sessions", { rows: [{ chat_id: CHAT_ID }] });
    world.db.program(STILL_OPEN_QUERY, { rows: [{ "?column?": 1 }] });
    world.db.program(ANSWER_QUERY, { rows: [] });

    await run(world, editParams("DROP TABLE message_queue", "ALTER TABLE message_queue"));

    const [edit] = telegram.editedContaining("⏰ Timeout");
    expect(edit).toBeDefined();
    expect(edit!.text).toContain("<pre><code");
    expect((edit!.extra as { reply_markup?: { inline_keyboard: unknown[] } })?.reply_markup?.inline_keyboard)
      .toEqual([]);
  });
});
