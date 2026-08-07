/**
 * The permission prompt as one message, and the body that survives the answer.
 *
 * Two things are asserted here that the previous rendering could not do. The
 * change and the question arrive together when they fit, and the change is
 * still a fenced block after the operator taps — which is the part that used to
 * break, because the answer was rebuilt from `ctx.callbackQuery.message.text`
 * and that string is the message with every entity stripped.
 *
 * The oversize path is asserted rather than assumed: Telegram does not truncate
 * a message over 4096 characters, it refuses it, so "it fits" is not a detail
 * to leave to inspection.
 */

import { describe, test, expect } from "bun:test";
import {
  fitsOneMessage,
  permissionKeyboard,
  renderAnswered,
  renderPrompt,
  renderPromptBody,
  shortPath,
  NO_KEYBOARD,
  PROMPT_HEADER,
  TELEGRAM_MESSAGE_MAX,
} from "../../utils/permission-message.ts";

const EDIT = {
  toolName: "Edit",
  descMain: "Edit\n/home/altsay/bots/helyx/memory/db.ts",
  change: "- await sql`DROP TABLE message_queue`\n+ await sql`ALTER TABLE message_queue`",
  lang: "diff",
};

describe("the tool line", () => {
  test("names the file by its last two segments, not its absolute path", () => {
    const body = renderPromptBody(EDIT);
    expect(body).toContain("memory/db.ts");
    expect(body).not.toContain("/home/altsay");
  });

  test("shortPath leaves a target with no separators alone", () => {
    expect(shortPath("$ ls -la")).toBe("$ ls -la");
  });

  test("a tool with no target renders the tool alone", () => {
    expect(renderPromptBody({ toolName: "Grep", descMain: "Grep", change: "" }))
      .toBe("<b>Grep</b>");
  });

  test("html in a path is escaped, not rendered", () => {
    const body = renderPromptBody({ toolName: "Edit", descMain: "Edit\nsrc/<b>x</b>.ts", change: "" });
    expect(body).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(body).not.toContain("<b>x</b>");
  });
});

describe("one message", () => {
  test("carries the header, the tool line and the change in a fenced block", () => {
    const text = renderPrompt(renderPromptBody(EDIT));
    expect(text.startsWith(PROMPT_HEADER)).toBe(true);
    expect(text).toContain("memory/db.ts");
    expect(text).toContain('<pre><code class="language-diff">');
    expect(text).toContain("DROP TABLE message_queue");
  });

  test("fits when the change is ordinary", () => {
    expect(fitsOneMessage(renderPromptBody(EDIT))).toBe(true);
  });

  test("does not fit when the change is larger than Telegram allows", () => {
    const body = renderPromptBody({ ...EDIT, change: "+ x".repeat(TELEGRAM_MESSAGE_MAX) });
    expect(fitsOneMessage(body)).toBe(false);
  });

  test("measures the escaped html, not the text it came from", () => {
    // `&` becomes `&amp;` — five characters where the operator sees one. A
    // length taken before escaping would call this deliverable when it is not.
    const raw = "&".repeat(1000);
    const body = renderPromptBody({ ...EDIT, change: raw });
    expect(body.length).toBeGreaterThan(renderPrompt(raw).length);
  });
});

describe("the answer", () => {
  test("keeps the body verbatim, fence and all", () => {
    const body = renderPromptBody(EDIT);
    for (const outcome of ["allow", "deny", "timeout", "terminal"] as const) {
      expect(renderAnswered(outcome, body)).toContain('<pre><code class="language-diff">');
      expect(renderAnswered(outcome, body).endsWith(body)).toBe(true);
    }
  });

  test("replaces the header and nothing else", () => {
    const body = renderPromptBody(EDIT);
    expect(renderAnswered("allow", body)).toBe(`✅ Allowed\n\n${body}`);
    expect(renderAnswered("deny", body)).toBe(`❌ Denied\n\n${body}`);
    expect(renderAnswered("timeout", body)).toBe(`⏰ Timeout\n\n${body}`);
    expect(renderAnswered("terminal", body)).toBe(`⚡ Resolved in terminal\n\n${body}`);
  });

  test("always names the tool it will stop asking about", () => {
    expect(renderAnswered("always", "b", "Edit")).toBe("✅ Always allowed: Edit\n\nb");
  });

  test("always without a tool name does not leave a dangling colon", () => {
    expect(renderAnswered("always", "b")).toBe("✅ Always allowed:\n\nb");
  });

  test("a plain body — the legacy row with nothing stored — still answers", () => {
    expect(renderAnswered("deny", "Bash\n$ rm -rf /tmp/x")).toBe("❌ Denied\n\nBash\n$ rm -rf /tmp/x");
  });
});

describe("the keyboard", () => {
  test("is the three buttons the callback router parses", () => {
    const kb = permissionKeyboard("req-9");
    expect(kb.inline_keyboard[0]!.map((b) => b.callback_data)).toEqual([
      "perm:allow:req-9",
      "perm:always:req-9",
      "perm:deny:req-9",
    ]);
  });

  test("clearing it is explicit — Telegram keeps the old markup otherwise", () => {
    expect(NO_KEYBOARD.inline_keyboard).toEqual([]);
  });
});
