/**
 * Reading a model's answer as it arrives.
 *
 * `claude/client.ts` holds three decisions inside its read loops, and all three
 * are about a stream: which lines of a Server-Sent Events body carry data, what
 * a chunk of that data means, and whether the text so far is still part of a
 * reasoning block that must not be shown.
 *
 * None of them needs a network. All of them are hard to get right at a chunk
 * boundary, which is exactly where a reader loop is least convenient to test —
 * so they live here, where a test can hand them the awkward split directly.
 *
 * The boundary matters more than it looks. A model does not send `<think>` as
 * one token; it sends `<`, then `th`, then `ink>`. A filter that asks "does
 * this chunk start a reasoning block?" gets three answers, all wrong, before it
 * gets a right one.
 */

import { REASONING_OPEN, REASONING_CLOSE } from "./llm-output.ts";

/**
 * Split a growing buffer into complete lines, keeping the remainder.
 *
 * Returned rather than mutated, because the remainder is the whole point: a
 * chunk almost never ends on a line boundary, and a reader that dropped the
 * tail would lose one message in every few.
 */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  // The carriage return goes with the newline it came with. SSE is specified
  // with CRLF and several providers send it; splitting on "\n" alone leaves a
  // trailing "\r" on every line, which turns the terminator into "[DONE]\r" —
  // not the terminator, so the stream is read past its own end.
  return { lines: parts.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line)), rest };
}

/** What one SSE line means. */
export type SseLine =
  | { kind: "data"; payload: string }
  | { kind: "done" }
  | { kind: "ignore" };

/**
 * Classify one line of an SSE body.
 *
 * Anything that is not a `data:` line is ignored — comments, blank separators
 * and event names all appear in real responses, and treating one of them as a
 * payload produces a parse warning per keep-alive.
 */
export function readSseLine(line: string): SseLine {
  if (!line.startsWith("data: ")) return { kind: "ignore" };
  const payload = line.slice(6);
  if (payload === "[DONE]") return { kind: "done" };
  return { kind: "data", payload };
}

export interface OpenAiChunk {
  /** Text to emit, if this chunk carried any. */
  content?: string;
  /** Token counts, which arrive on the final chunk rather than the first. */
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Read one OpenAI-compatible streaming chunk.
 *
 * Returns `null` for anything unparseable rather than throwing: a malformed
 * chunk in the middle of an answer should cost that chunk, not the answer.
 */
export function parseOpenAiChunk(payload: string): OpenAiChunk | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const chunk: OpenAiChunk = {};
  const usage = parsed.usage as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  if (usage) {
    if (typeof usage.prompt_tokens === "number") chunk.inputTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === "number") chunk.outputTokens = usage.completion_tokens;
  }

  const choices = parsed.choices as { delta?: { content?: unknown } }[] | undefined;
  const content = choices?.[0]?.delta?.content;
  if (typeof content === "string" && content) chunk.content = content;

  return chunk;
}

/** Read one line of Ollama's newline-delimited chat stream. */
export function parseOllamaLine(line: string): string | null {
  if (!line.trim()) return null;
  try {
    const data = JSON.parse(line) as { message?: { content?: unknown } };
    const content = data?.message?.content;
    return typeof content === "string" && content ? content : null;
  } catch {
    return null;
  }
}

/**
 * Hides a reasoning block while the answer streams through it.
 *
 * Hybrid reasoning models emit `<think>…</think>` before the answer. Asking
 * `stripReasoning` is not an option here: that matches a whole block, and this
 * sees a few characters at a time and has to decide what to forward *now*.
 *
 * Three states, and the first is the one that matters. An earlier version
 * skipped everything until it saw `</think>`, which swallowed the entire answer
 * from any model that emits no reasoning block at all — including the same
 * models once the request asked them not to. So the filter decides whether a
 * block is present before it decides to hide anything, and while it cannot yet
 * tell, it holds the text rather than guessing either way.
 */
export class ReasoningFilter {
  private phase: "deciding" | "thinking" | "passthrough" = "deciding";
  private pending = "";

  /** What this content should produce, if anything. */
  push(content: string): string {
    if (this.phase === "passthrough") return content;

    this.pending += content;

    if (this.phase === "deciding") {
      const head = this.pending.trimStart();
      if (!head) return "";
      if (head.startsWith(REASONING_OPEN)) {
        this.phase = "thinking";
      } else if (head.length < REASONING_OPEN.length && REASONING_OPEN.startsWith(head)) {
        // Still ambiguous: `<th` could become `<think>` or could be the answer
        // starting with a tag. Held until one more character decides it.
        return "";
      } else {
        this.phase = "passthrough";
        const out = this.pending;
        this.pending = "";
        return out;
      }
    }

    if (this.phase === "thinking") {
      const idx = this.pending.indexOf(REASONING_CLOSE);
      if (idx !== -1) {
        const after = this.pending.slice(idx + REASONING_CLOSE.length);
        this.phase = "passthrough";
        this.pending = "";
        return after;
      }
    }

    return "";
  }

  /**
   * What is left when the stream ends.
   *
   * A reply shorter than `<think>` ends while still ambiguous and must be
   * flushed rather than dropped — "ok" is a complete answer. An unterminated
   * reasoning block is discarded on purpose: it is the model's working, and
   * showing half of it is worse than showing none.
   */
  flush(): string {
    if (this.phase === "deciding" && this.pending) {
      const out = this.pending;
      this.pending = "";
      return out;
    }
    return "";
  }

  /** For assertions and diagnostics. */
  get state(): "deciding" | "thinking" | "passthrough" {
    return this.phase;
  }
}

/** How many times a failed call is retried before giving up. */
export const MAX_RETRIES = 3;
/** The first backoff, doubled each attempt. */
export const RETRY_BASE_MS = 2000;

/**
 * Whether this failure is worth trying again.
 *
 * Rate limits and server errors are transient; everything else — a bad key, a
 * malformed request, a model that does not exist — will fail again identically,
 * and retrying it three times only delays the error by fourteen seconds.
 */
export function isRetryable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  if (!message) return false;
  if (message.includes("429") || /rate/i.test(message)) return true;
  return /\b5\d\d\b/.test(message);
}

/**
 * How long to wait before attempt `attempt` (zero-based).
 *
 * Exponential, with up to a second of jitter. The jitter is not decoration: two
 * sessions rate-limited by the same provider at the same moment would otherwise
 * retry in lockstep forever.
 */
export function retryDelay(attempt: number, random: () => number = Math.random): number {
  return RETRY_BASE_MS * Math.pow(2, attempt) + random() * 1000;
}

export type Provider = "anthropic" | "google-ai" | "openai" | "ollama";

/**
 * Which provider a configuration selects.
 *
 * Ordered by preference, and it falls through to a local model rather than
 * failing: a machine with no keys at all still runs, which is what makes the
 * project usable before anything is configured.
 */
export function selectProvider(keys: {
  anthropic?: string;
  googleAi?: string;
  openrouter?: string;
}): Provider {
  if (keys.anthropic) return "anthropic";
  if (keys.googleAi) return "google-ai";
  if (keys.openrouter) return "openai";
  return "ollama";
}
