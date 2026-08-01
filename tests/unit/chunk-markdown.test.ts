/**
 * Markdown-aware chunking.
 *
 * A cut inside a fenced code block leaves the fence unterminated, Telegram
 * refuses to parse the message, and the send falls back through HTML to plain
 * text — so one careless boundary strips the formatting off everything in that
 * chunk. These tests pin the boundaries that must never be chosen.
 */

import { describe, expect, test } from "bun:test";
import { chunkMarkdown } from "../../utils/chunk.ts";
import {
  asRecapQuote,
  proseOf,
  shouldSummarize,
  SUMMARY_MIN_CHARS,
} from "../../utils/reply-summary.ts";

/** Every fenced block in a chunk must be closed within that chunk. */
const fencesBalanced = (s: string) => (s.match(/^\s*```/gm) ?? []).length % 2 === 0;

describe("chunkMarkdown", () => {
  test("returns short text as a single chunk", () => {
    expect(chunkMarkdown("hello", 4096)).toEqual(["hello"]);
  });

  test("drops empty input rather than sending a blank message", () => {
    expect(chunkMarkdown("   \n\n ", 4096)).toEqual([]);
  });

  test("never cuts inside a fenced code block", () => {
    const text = [
      "Intro paragraph that eats some of the budget.",
      "",
      "```ts",
      ...Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`),
      "```",
      "",
      "Trailing paragraph.",
    ].join("\n");

    const chunks = chunkMarkdown(text, 300);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(fencesBalanced(c)).toBe(true);
  });

  test("emits an oversized code block whole instead of bisecting it", () => {
    // Cutting it would be the one outcome worse than an overlong message.
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkMarkdown(`before\n\n\`\`\`\n${body}\n\`\`\`\n\nafter`, 120);
    for (const c of chunks) expect(fencesBalanced(c)).toBe(true);
    expect(chunks.join("\n")).toContain("line 59");
  });

  test("keeps a table header with its rows", () => {
    const table = [
      "Some prose before the table to use up room.",
      "",
      "| col | val |",
      "|:---|:---|",
      ...Array.from({ length: 12 }, (_, i) => `| row ${i} | ${i} |`),
      "",
      "After.",
    ].join("\n");

    const chunks = chunkMarkdown(table, 200);
    for (const c of chunks) {
      const rows = c.split("\n").filter((l) => l.startsWith("|"));
      // A chunk that carries table rows must carry the separator that defines
      // the table; orphaned rows render as literal pipes.
      if (rows.length) expect(rows.some((l) => /^\|\s*:?-/.test(l))).toBe(true);
    }
  });

  test("loses no content", () => {
    const text = Array.from({ length: 50 }, (_, i) => `Paragraph number ${i}.`).join("\n\n");
    const rejoined = chunkMarkdown(text, 200).join("\n\n");
    for (let i = 0; i < 50; i++) expect(rejoined).toContain(`Paragraph number ${i}.`);
  });

  test("respects the length budget for text with no oversized block", () => {
    const text = Array.from({ length: 80 }, (_, i) => `Line ${i}`).join("\n");
    for (const c of chunkMarkdown(text, 200)) expect(c.length).toBeLessThanOrEqual(200);
  });

  test("splits on line boundaries, never mid-word", () => {
    const text = Array.from({ length: 40 }, (_, i) => `sentence number ${i} here`).join("\n");
    for (const c of chunkMarkdown(text, 150)) {
      expect(c.startsWith("sentence")).toBe(true);
      expect(c.endsWith("here")).toBe(true);
    }
  });
});

describe("shouldSummarize", () => {
  test("skips a short reply — it is already readable at a glance", () => {
    expect(shouldSummarize("ok, done")).toBe(false);
    expect(shouldSummarize("х".repeat(SUMMARY_MIN_CHARS - 1))).toBe(false);
  });

  test("summarises from the threshold up", () => {
    expect(shouldSummarize("х".repeat(SUMMARY_MIN_CHARS))).toBe(true);
  });

  test("a reply that is all code earns no recap, however long", () => {
    // Narrating a diff aloud produces filler — there is no prose to carry.
    const reply = "Готово.\n\n```ts\n" + "const x = 1;\n".repeat(60) + "```";
    expect(shouldSummarize(reply)).toBe(false);
  });

  test("prose alongside the code still earns one", () => {
    const reply =
      "Ч".repeat(SUMMARY_MIN_CHARS) + "\n\n```ts\n" + "const x = 1;\n".repeat(60) + "```";
    expect(shouldSummarize(reply)).toBe(true);
  });
});

describe("proseOf", () => {
  test("drops fenced blocks, inline code, tables and links", () => {
    const text = [
      "Итог такой.",
      "",
      "```ts",
      "const secret = 1;",
      "```",
      "",
      "| col | val |",
      "|:---|:---|",
      "| a | 1 |",
      "",
      "Смотри `chunkMarkdown` и https://example.com/x.",
    ].join("\n");

    const prose = proseOf(text);
    expect(prose).toContain("Итог такой.");
    expect(prose).not.toContain("secret");
    expect(prose).not.toContain("|");
    expect(prose).not.toContain("chunkMarkdown");
    expect(prose).not.toContain("example.com");
  });

  test("an unterminated fence swallows the rest — a cut chunk is still all code", () => {
    expect(proseOf("Вот:\n\n```ts\nconst secret = 1;")).toBe("Вот:");
  });
});

describe("asRecapQuote", () => {
  test("marks every line, so the aside cannot read as a second answer", () => {
    const quoted = asRecapQuote("первая строка\nвторая строка");
    for (const line of quoted.split("\n")) expect(line.startsWith(">")).toBe(true);
  });

  test("keeps blank lines inside the quote without trailing spaces", () => {
    expect(asRecapQuote("один\n\nдва")).toBe("> один\n>\n> два");
  });
});
