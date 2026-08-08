import Anthropic from "@anthropic-ai/sdk";
import { stripReasoning } from "../utils/llm-output.ts";
import {
  takeLines,
  readSseLine,
  parseOpenAiChunk,
  parseOllamaLine,
  ReasoningFilter,
  isRetryable,
  retryDelay,
  selectProvider,
  MAX_RETRIES,
} from "../utils/llm-stream.ts";
import { CONFIG } from "../config.ts";
import { recordApiRequest } from "../utils/stats.ts";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp"; data: string } };

export type MessageParam = { role: "user" | "assistant"; content: string | ContentBlock[] };

/** Extract text content from a message for non-Anthropic providers */
function contentToString(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b) => b.type === "text")
    .map((b) => (b as { type: "text"; text: string }).text)
    .join("\n");
}

/** Convert messages to plain text for OpenAI/Ollama */
function toTextMessages(messages: MessageParam[]): { role: string; content: string }[] {
  return messages.map((m) => ({ role: m.role, content: contentToString(m.content) }));
}

// --- Retry with backoff ---

/**
 * Retry a transient failure with exponential backoff.
 *
 * `sleep` is a parameter so the loop itself can be tested. Its default is the
 * real wait, and the real wait is fourteen seconds across three attempts —
 * correct for a rate-limited provider, and not something a test can sit through.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      if (isRetryable(err) && attempt < MAX_RETRIES) {
        const delay = retryDelay(attempt);
        console.log(`[client] ${label} retry ${attempt + 1}/${MAX_RETRIES} after ${Math.round(delay)}ms`);
        await sleep(delay);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// Provider detection: anthropic > google-ai > openai-compatible (openrouter etc) > ollama
const googleAiUrl = "https://generativelanguage.googleapis.com/v1beta/openai";

const provider = selectProvider({
  anthropic: CONFIG.ANTHROPIC_API_KEY,
  googleAi: CONFIG.GOOGLE_AI_API_KEY,
  openrouter: CONFIG.OPENROUTER_API_KEY,
});

const anthropic = provider === "anthropic" ? new Anthropic() : null;

// Resolve effective OpenAI-compat settings (Google AI uses the same protocol)
const effectiveApiKey = provider === "google-ai" ? CONFIG.GOOGLE_AI_API_KEY : CONFIG.OPENROUTER_API_KEY;
const effectiveBaseUrl = provider === "google-ai" ? googleAiUrl : CONFIG.OPENROUTER_BASE_URL;
const effectiveModel = provider === "google-ai" ? CONFIG.GOOGLE_AI_MODEL : CONFIG.OPENROUTER_MODEL;

export function getProviderInfo() {
  const model = provider === "anthropic" ? CONFIG.CLAUDE_MODEL
    : provider === "google-ai" ? CONFIG.GOOGLE_AI_MODEL
    : provider === "openai" ? CONFIG.OPENROUTER_MODEL
    : CONFIG.OLLAMA_CHAT_MODEL;
  return { provider, model };
}

console.log(`[client] provider: ${provider}${
  provider === "google-ai" ? ` (${CONFIG.GOOGLE_AI_MODEL} @ Google AI)`
  : provider === "openai" ? ` (${CONFIG.OPENROUTER_MODEL} @ ${CONFIG.OPENROUTER_BASE_URL})`
  : provider === "ollama" ? ` (${CONFIG.OLLAMA_CHAT_MODEL})`
  : ""
}`);

// --- OpenAI-compatible API (OpenRouter) ---

// Per-call usage tracking for streaming (avoids global mutable state race)
interface StreamUsage { input?: number; output?: number; }

/** Shared fetch for OpenAI-compatible APIs (OpenRouter, Google AI) */
async function fetchOpenai(
  messages: { role: string; content: string }[],
  stream: boolean,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: effectiveModel,
    messages,
    stream,
  };
  if (stream) body.stream_options = { include_usage: true };

  const res = await fetch(`${effectiveBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${effectiveApiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok && (res.status === 429 || res.status >= 500)) {
    throw new Error(`API failed: ${res.status} ${await res.text()}`);
  }

  return res;
}

export async function* openaiStream(
  messages: MessageParam[],
  system: string,
  usage: StreamUsage = {},
): AsyncGenerator<string> {

  const res = await withRetry(() => fetchOpenai(
    [{ role: "system", content: system }, ...toTextMessages(messages)],
    true,
  ), "stream");

  if (!res.ok) {
    throw new Error(`API failed: ${res.status} ${await res.text()}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const { lines, rest } = takeLines(buffer);
    buffer = rest;

    for (const line of lines) {
      const event = readSseLine(line);
      if (event.kind === "ignore") continue;
      if (event.kind === "done") return;

      const chunk = parseOpenAiChunk(event.payload);
      if (!chunk) continue;
      // Usage arrives on the final chunk rather than the first.
      if (chunk.inputTokens !== undefined) usage.input = chunk.inputTokens;
      if (chunk.outputTokens !== undefined) usage.output = chunk.outputTokens;
      if (chunk.content) yield chunk.content;
    }
  }
}

interface GenerateResult {
  content: string;
  inputTokens?: number;
  outputTokens?: number;
}

export async function openaiGenerate(
  messages: MessageParam[],
  system: string,
): Promise<GenerateResult> {
  const res = await withRetry(() => fetchOpenai(
    [{ role: "system", content: system }, ...toTextMessages(messages)],
    false,
  ), "generate");

  if (!res.ok) {
    throw new Error(`API failed: ${res.status} ${await res.text()}`);
  }

  interface OpenAIResponse {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }
  const data = (await res.json()) as OpenAIResponse;
  let content = data.choices?.[0]?.message?.content ?? "";
  content = stripReasoning(content);
  return {
    content,
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  };
}

// --- Ollama chat API ---

export async function* ollamaStream(
  messages: MessageParam[],
  system: string,
): AsyncGenerator<string> {
  const res = await fetch(`${CONFIG.OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CONFIG.OLLAMA_CHAT_MODEL,
      messages: [{ role: "system", content: system }, ...toTextMessages(messages)],
      stream: true,
      // Hybrid reasoning models (Qwen3 and friends) emit a <think> block by
      // default. We do not want it: it is latency and tokens spent on output
      // nobody reads. Older Ollama ignores this field, hence the stripping below.
      think: false,
    }),
  });

  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status}`);

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  // Reasoning-block state machine — see utils/llm-stream.ts. It lives there
  // because it is hardest exactly at a chunk boundary, which is the one thing a
  // live model will not reproduce on request.
  const reasoning = new ReasoningFilter();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const { lines, rest } = takeLines(buffer);
    buffer = rest;

    for (const line of lines) {
      const content = parseOllamaLine(line);
      if (content === null) continue;
      const out = reasoning.push(content);
      if (out) yield out;
    }
  }

  const tail = reasoning.flush();
  if (tail) yield tail;
}

async function ollamaGenerate(
  messages: MessageParam[],
  system: string,
): Promise<GenerateResult> {
  const res = await fetch(`${CONFIG.OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: CONFIG.OLLAMA_CHAT_MODEL,
      messages: [{ role: "system", content: system }, ...toTextMessages(messages)],
      stream: false,
      // See ollamaStream: suppress the reasoning block; the strip below is the
      // fallback for Ollama versions that ignore this field.
      think: false,
    }),
  });

  if (!res.ok) throw new Error(`Ollama chat failed: ${res.status}`);

  const data = (await res.json()) as any;
  let content = data.message?.content ?? "";
  content = stripReasoning(content);
  return {
    content,
    inputTokens: data.prompt_eval_count,
    outputTokens: data.eval_count,
  };
}

// --- Public API ---

export interface StreamContext {
  sessionId?: number | null;
  chatId?: string | null;
  operation?: string;
}

export async function* streamResponse(
  messages: MessageParam[],
  system: string,
  ctx?: StreamContext,
): AsyncGenerator<string> {
  const { provider: p, model: m } = getProviderInfo();
  const start = Date.now();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  let error: string | undefined;

  try {
    switch (provider) {
      case "google-ai":
      case "openai": {
        const streamUsage: StreamUsage = {};
        yield* openaiStream(messages, system, streamUsage);
        inputTokens = streamUsage.input;
        outputTokens = streamUsage.output;
      }
        break;
      case "ollama":
        yield* ollamaStream(messages, system);
        break;
      case "anthropic": {
        const stream = anthropic!.messages.stream({
          model: CONFIG.CLAUDE_MODEL,
          max_tokens: CONFIG.MAX_TOKENS,
          system,
          messages,
        });
        for await (const event of stream) {
          if (
            event.type === "content_block_delta" &&
            event.delta.type === "text_delta"
          ) {
            yield event.delta.text;
          }
          if (event.type === "message_delta" && (event as any).usage) {
            outputTokens = (event as any).usage.output_tokens;
          }
        }
        const final = await stream.finalMessage();
        inputTokens = final.usage?.input_tokens;
        outputTokens = final.usage?.output_tokens;
        break;
      }
    }
  } catch (err: any) {
    error = err?.message ?? String(err);
    throw err;
  } finally {
    recordApiRequest({
      sessionId: ctx?.sessionId,
      chatId: ctx?.chatId,
      provider: p,
      model: m,
      operation: ctx?.operation ?? "chat",
      durationMs: Date.now() - start,
      status: error ? "error" : "success",
      inputTokens,
      outputTokens,
      totalTokens: inputTokens && outputTokens ? inputTokens + outputTokens : null,
      errorMessage: error,
    });
  }
}

export async function generateResponse(
  messages: MessageParam[],
  system: string,
  ctx?: StreamContext,
): Promise<string> {
  const { provider: p, model: m } = getProviderInfo();
  const start = Date.now();
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  try {
    let result: string;
    switch (provider) {
      case "google-ai":
      case "openai": {
        const r = await openaiGenerate(messages, system);
        result = r.content;
        inputTokens = r.inputTokens;
        outputTokens = r.outputTokens;
        break;
      }
      case "ollama": {
        const r = await ollamaGenerate(messages, system);
        result = r.content;
        inputTokens = r.inputTokens;
        outputTokens = r.outputTokens;
        break;
      }
      case "anthropic": {
        const response = await anthropic!.messages.create({
          model: CONFIG.CLAUDE_MODEL,
          max_tokens: CONFIG.MAX_TOKENS,
          system,
          messages,
        });
        inputTokens = response.usage?.input_tokens;
        outputTokens = response.usage?.output_tokens;
        result = response.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("");
        break;
      }
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }

    recordApiRequest({
      sessionId: ctx?.sessionId,
      chatId: ctx?.chatId,
      provider: p,
      model: m,
      operation: ctx?.operation ?? "generate",
      durationMs: Date.now() - start,
      status: "success",
      inputTokens,
      outputTokens,
      totalTokens: inputTokens && outputTokens ? inputTokens + outputTokens : null,
    });

    return result;
  } catch (err: any) {
    recordApiRequest({
      sessionId: ctx?.sessionId,
      chatId: ctx?.chatId,
      provider: p,
      model: m,
      operation: ctx?.operation ?? "generate",
      durationMs: Date.now() - start,
      status: "error",
      errorMessage: err?.message ?? String(err),
    });
    throw err;
  }
}

/**
 * Coerce an LLM-produced summary payload into the shape callers expect.
 *
 * The model is asked for `{ summary, facts: string[] }`, but at runtime it may
 * omit `facts`, return `facts: null`, or mix in non-strings. Returning the raw
 * `JSON.parse` result meant `facts` was `undefined` downstream and `facts.filter`
 * threw — crashing the disconnect handoff. This guarantees `facts` is always a
 * string array no matter what the model emitted.
 */
export function normalizeSummaryResult(parsed: unknown): { summary: string; facts: string[] } {
  const obj = (parsed && typeof parsed === "object" ? parsed : {}) as Record<string, unknown>;
  const rawFacts = obj.facts;
  return {
    summary: typeof obj.summary === "string" ? obj.summary : String(obj.summary ?? ""),
    facts: Array.isArray(rawFacts) ? rawFacts.filter((f): f is string => typeof f === "string") : [],
  };
}

/**
 * How long a summary may take, and how long it may be.
 *
 * These two are one decision, so they live together. `num_predict` is the length
 * a summary needs; the ceiling is what that length costs on the model the host
 * actually runs, and the cost is measured rather than guessed.
 *
 * Measured 2026-08-08 on gemma4:e4b (`geekom-model-1`), CPU-only, 27 GB box:
 * a cold load takes 17.2s before a token appears, and generation runs at
 * 9.3–12 tok/s. So 400 tokens from cold is roughly 17 + 43 = 60s, and a 60s
 * ceiling would land exactly on it. The old ceiling was 30s, which the smaller
 * gemma4:e2b made in 17s and e4b missed at 35s — a miss is not a slow summary,
 * it is an abort into the paid cloud model below, every single time.
 *
 * Shortening the answer instead was the alternative and is worse: a truncated
 * reply fails `JSON.parse` and falls through to the same cloud model, so it buys
 * nothing and loses the summary. Seconds are cheap here — this runs from
 * `memory/summarizer.ts` after a session ends, with nobody waiting on a screen.
 * The latency-sensitive readers of `SUMMARIZE_MODEL` (`/now` at 6s, the health
 * digest at 15s) are deliberately not raised to match.
 */
export const SUMMARIZE_NUM_PREDICT = 400;
export const SUMMARIZE_TIMEOUT_MS = 90_000;

/** The measurements the ceiling above is derived from, kept so a test can check the arithmetic. */
export const SUMMARIZE_COLD_LOAD_MS = 17_200;
export const SUMMARIZE_SLOWEST_TOKENS_PER_SEC = 9.3;

export async function summarizeConversation(
  messages: { role: string; content: string }[],
): Promise<{ summary: string; facts: string[] }> {
  const formatted = messages
    .map((m) => `${m.role}: ${m.content}`)
    .join("\n");

  const userPrompt = `Analyze this conversation and return JSON:
{
  "summary": "brief description of the conversation in 2-3 sentences",
  "facts": ["fact 1 about the user or decisions", "fact 2", ...]
}

Conversation:
${formatted}`;

  const systemPrompt = "You extract structured information from conversations. Reply only with valid JSON, no markdown.";

  // Use local Ollama model for summarization if configured (cheaper, offline)
  if (CONFIG.SUMMARIZE_MODEL && CONFIG.OLLAMA_URL) {
    try {
      const res = await fetch(`${CONFIG.OLLAMA_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: CONFIG.SUMMARIZE_MODEL,
          think: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          stream: false,
          format: "json",
          options: { num_predict: SUMMARIZE_NUM_PREDICT, temperature: 0.2 },
        }),
        signal: AbortSignal.timeout(SUMMARIZE_TIMEOUT_MS),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        const text = stripReasoning(data.message?.content ?? "");
        try { return normalizeSummaryResult(JSON.parse(text)); } catch { /* fall through to main model */ }
      }
    } catch { /* timeout or connection error — fall through to main model */ }
  }

  const response = await generateResponse(
    [{ role: "user", content: userPrompt }],
    systemPrompt,
  );

  try {
    return normalizeSummaryResult(JSON.parse(response));
  } catch {
    return { summary: response, facts: [] };
  }
}
