/**
 * Cleaning up what a model actually returns.
 *
 * Hybrid reasoning models — Qwen3 and its relatives — emit a `<think>` block
 * before their answer. Two callers had to remove it and each carried its own
 * copy of the pattern: the Anthropic-compatible client and the supervisor's
 * Ollama call.
 *
 * The block belongs to the model's output format, not to either caller. If a
 * model started tagging it differently, both would have to change together.
 */

const REASONING_BLOCK = /<think>[\s\S]*?<\/think>/g;

/**
 * Remove reasoning blocks and surrounding whitespace.
 *
 * Non-greedy and global: a response may carry several blocks, and a greedy
 * match would swallow everything between the first `<think>` and the last
 * `</think>` — including the answer.
 */
export function stripReasoning(text: string): string {
  return text.replace(REASONING_BLOCK, "").trim();
}
