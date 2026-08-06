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
  fitRecap,
  proseOf,
  shouldSummarize,
  RECAP_PREFIX,
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

  test("carries an oversized code block across chunks, fence closed and re-opened", () => {
    // This used to emit the block whole — "an oversized message is Telegram's
    // problem to reject". Telegram rejected it, the send bailed, and the whole
    // reply was lost. Every piece must now fit and parse on its own.
    const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
    const chunks = chunkMarkdown(`before\n\n\`\`\`\n${body}\n\`\`\`\n\nafter`, 120);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(fencesBalanced(c)).toBe(true);
      expect(c.length).toBeLessThanOrEqual(120);
    }
    for (let i = 0; i < 60; i++) expect(chunks.join("\n")).toContain(`line ${i}`);
  });

  test("keeps the info string when it re-opens a fence, so highlighting survives", () => {
    const body = Array.from({ length: 40 }, (_, i) => `const line${i} = ${i};`).join("\n");
    const chunks = chunkMarkdown(`\`\`\`ts\n${body}\n\`\`\``, 200);

    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.startsWith("```ts")).toBe(true);
  });

  test("a paragraph longer than one message is cut on a word, not lost", () => {
    // The other shape of the same defect: no fence to preserve and nowhere to
    // break but inside the line itself.
    const text = `${"слово ".repeat(200)}конец.`;
    const chunks = chunkMarkdown(text, 300);

    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
    expect(chunks.join(" ")).toContain("конец.");
    for (const c of chunks) expect(c).not.toMatch(/сло$/);
  });

  test("no chunk is ever over the budget, whatever the shape", () => {
    // The one property the send depends on: what comes out of here is a
    // message Telegram will accept.
    const shapes = [
      `\`\`\`\n${"x".repeat(9000)}\n\`\`\``, // one enormous line inside a fence
      `\`\`\`ts\n${"const x = 1;\n".repeat(900)}\`\`\``, // a long block of short lines
      "y".repeat(9000), // one enormous line, no spaces at all
      `intro\n\n\`\`\`\n${"z".repeat(9000)}\n\`\`\`\n\noutro`, // prose around it
      `\`\`\`\n${"unterminated ".repeat(800)}`, // a fence nobody closed
    ];

    for (const shape of shapes) {
      const chunks = chunkMarkdown(shape, 4096);
      expect(chunks.length).toBeGreaterThan(0);
      for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    }
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
  test("quotes the recap, so the aside cannot read as a second answer", () => {
    expect(asRecapQuote("первая строка\nвторая строка"))
      .toBe("<blockquote expandable>первая строка\nвторая строка</blockquote>");
  });

  test("collapses by default — a recap of a reply already read must not cost scrolling", () => {
    expect(asRecapQuote("текст")).toContain("expandable");
  });

  test("escapes the summary, so a stray angle bracket cannot break the quote", () => {
    expect(asRecapQuote("сравнил a < b & b > c"))
      .toBe("<blockquote expandable>сравнил a &lt; b &amp; b &gt; c</blockquote>");
  });
});

/**
 * The recap fitted to a message.
 *
 * The defect this replaces was `slice(0, 700)`: a recap that overran its budget
 * ended in the middle of a word, and what the operator read was not "there was
 * more" but a session that had stopped mid-thought.
 */
describe("fitRecap", () => {
  /** What the caller actually sends, and therefore what the budget applies to. */
  const rendered = (t: string) => asRecapQuote(`${RECAP_PREFIX}${t}`).length;

  test("a recap that fits is not touched", () => {
    const text = "Правка ушла в main. Тесты зелёные.";
    expect(fitRecap(text)).toBe(text);
  });

  test("an overlong recap ends on a sentence, not mid-word", () => {
    const sentence = `${"слово ".repeat(20)}конец.`;
    const out = fitRecap(Array(40).fill(sentence).join(" "), 500);

    expect(rendered(out)).toBeLessThanOrEqual(500);
    expect(out.endsWith("конец.")).toBe(true);
  });

  test("the budget is measured after escaping, not before", () => {
    // Prose is short enough to fit raw and too long once every `&` has become
    // five characters. Counting before the escape is the bug that lets a
    // message Telegram will reject through.
    const text = `${"a & b. ".repeat(30)}`;
    const out = fitRecap(text, 300);

    expect(rendered(out)).toBeLessThanOrEqual(300);
  });

  test("one enormous sentence is cut on a word and says so", () => {
    // No sentence boundary anywhere, so the fallback decides — and an ellipsis
    // is the difference between "there was more" and "it died here".
    const out = fitRecap("слово ".repeat(300).trim(), 200);

    expect(rendered(out)).toBeLessThanOrEqual(200);
    expect(out.endsWith("…")).toBe(true);
    expect(out).not.toMatch(/сло…$/);
  });

  test("the quote tags and the speaker glyph come out of the same budget", () => {
    // A cap that ignores its own wrapper is a cap that overruns by the size of
    // the wrapper — which is what sends a message Telegram refuses.
    const out = fitRecap("Одно. Два. Три. Четыре. Пять. Шесть.", 60);

    expect(rendered(out)).toBeLessThanOrEqual(60);
  });
});
