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
} from "../../utils/permission-render.ts";

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

  test("a Bash command is shown whole, never shortened like a path", () => {
    // The defect this guards against: `shortPath("$ rm -rf /var/log/app")`
    // returns "log/app". Applied to a command that is not what the operator is
    // approving — it is a different command, and the dangerous half is gone.
    const body = renderPromptBody({
      toolName: "Bash",
      descMain: "Bash\n$ rm -rf /var/log/app",
      change: "",
    });
    expect(body).toContain("rm -rf /var/log/app");
    expect(body).not.toContain(">log/app<");
  });

  test("a Grep pattern with slashes is shown whole", () => {
    const body = renderPromptBody({
      toolName: "Grep",
      descMain: 'Grep\ngrep "src/utils/tts.ts"',
      change: "",
    });
    expect(body).toContain("src/utils/tts.ts");
    expect(body).toContain("grep");
  });

  test("only a path tool gets its target shortened", () => {
    const asEdit = renderPromptBody({ toolName: "Edit", descMain: "Edit\n/a/b/c/d.ts", change: "" });
    const asBash = renderPromptBody({ toolName: "Bash", descMain: "Bash\n/a/b/c/d.ts", change: "" });
    expect(asEdit).toContain("c/d.ts");
    expect(asEdit).not.toContain("/a/b/c");
    expect(asBash).toContain("/a/b/c/d.ts");
  });

  test("an unbounded target is clamped so the head alone always fits", () => {
    const body = renderPromptBody({
      toolName: "Bash",
      descMain: `Bash\n$ ${"x".repeat(TELEGRAM_MESSAGE_MAX * 2)}`,
      change: "",
    });
    expect(body).toContain("…");
    expect(fitsOneMessage(body)).toBe(true);
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

  test("escapes the change, so a diff cannot open a tag", () => {
    const body = renderPromptBody({ ...EDIT, change: '- <script>alert(1)</script>\n+ a & b' });
    expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(body).toContain("a &amp; b");
    expect(body).not.toContain("<script>");
  });

  test("measures the escaped html, not the text it came from", () => {
    // `&` becomes `&amp;` — five characters where the operator sees one, so a
    // change that fits before escaping can fail to fit after it. Measured by
    // comparing two bodies that differ only in what escaping does to them.
    const plain = renderPromptBody({ ...EDIT, change: "a".repeat(1000) });
    const escaped = renderPromptBody({ ...EDIT, change: "&".repeat(1000) });
    expect(escaped.length).toBe(plain.length + 1000 * "&amp;".length - 1000);
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
