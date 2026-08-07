/**
 * Translation between the Anthropic Messages API and Ollama's `/api/chat`.
 *
 * Claude Code speaks Anthropic; Ollama does not, and has no Anthropic route to
 * point at. Everything in this file is the dialect gap, expressed as pure
 * functions so both directions can be asserted without a running model — the
 * failures this code exists to prevent (a dropped system prompt, a tool call
 * reported as `end_turn`, a truncated context) are all silent, and a test is the
 * only place they become visible.
 *
 * No I/O lives here. `scripts/ollama-proxy.ts` owns the sockets.
 *
 * Specification: docs/requirements/ollama-provider-2026-08-07/prd.md §4.
 */

// ─── Anthropic side ──────────────────────────────────────────────────────────

export interface AnthropicTextBlock {
  type: "text";
  text: string;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

export interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: unknown;
  is_error?: boolean;
}

export interface AnthropicImageBlock {
  type: "image";
  source?: unknown;
}

export type AnthropicBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicImageBlock
  | { type: string; [k: string]: unknown };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

export interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

export interface AnthropicRequest {
  model?: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicBlock[];
  tools?: AnthropicTool[];
  tool_choice?: { type?: string };
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

export interface AnthropicResponse {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: (AnthropicTextBlock | AnthropicToolUseBlock)[];
  stop_reason: StopReason;
  stop_sequence: null;
  usage: AnthropicUsage;
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens";

// ─── Ollama side ─────────────────────────────────────────────────────────────

export interface OllamaToolCall {
  function: { name: string; arguments: Record<string, unknown> };
}

export interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: OllamaToolCall[];
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream: boolean;
  think: boolean;
  tools?: { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  options: Record<string, unknown>;
}

/** One streamed object from `/api/chat`. The final one carries `done: true`. */
export interface OllamaChunk {
  message?: { role?: string; content?: string; tool_calls?: OllamaToolCall[]; thinking?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

// ─── Errors ──────────────────────────────────────────────────────────────────

export type AnthropicErrorType = "invalid_request_error" | "api_error" | "not_found_error";

/**
 * A failure that must reach the client as Anthropic's error envelope.
 *
 * The failure mode this exists to prevent is the one that started this flow: a
 * session that will not start, with nothing on screen saying why.
 */
export class TranslationError extends Error {
  constructor(
    readonly errorType: AnthropicErrorType,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "TranslationError";
  }
}

export function errorBody(type: AnthropicErrorType, message: string): string {
  return JSON.stringify({ type: "error", error: { type, message } });
}

// ─── Request: Anthropic → Ollama ─────────────────────────────────────────────

/** Flatten Anthropic's `system` — it is a string on some requests, blocks on others. */
export function flattenSystem(system: AnthropicRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system;
  return system
    .filter((b): b is AnthropicTextBlock => b.type === "text" && typeof (b as AnthropicTextBlock).text === "string")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
}

/** Render a `tool_result`'s content, which may be a string or a block array. */
function renderToolResultContent(content: unknown): string {
  if (content == null) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as AnthropicBlock;
        if (block?.type === "text") return (block as AnthropicTextBlock).text ?? "";
        // A non-text result block (an image, typically) has no Ollama
        // representation. Say so in-band rather than sending an empty result,
        // which reads to the model as a tool that returned nothing.
        return `[${block?.type ?? "unknown"} content omitted]`;
      })
      .join("\n");
  }
  return JSON.stringify(content);
}

export interface TranslateOptions {
  /** The Ollama model to actually run — already resolved, see resolveModel(). */
  model: string;
  /** The model's real context length. Never omitted: see the note below. */
  numCtx: number;
  stream: boolean;
  /** Collects blocks that could not be represented, for the caller to log. */
  onDropped?: (what: string) => void;
}

/**
 * Build the `/api/chat` body.
 *
 * `options.num_ctx` is always set, and that is the single most important line
 * here. Ollama does not fall back to the model's own context length — neither
 * `geekom-model-1`'s Modelfile nor this host's `ollama.service` supplies one —
 * so without it the server's default window applies and the prompt is truncated
 * from the front. Claude Code's system prompt and tool definitions do not fit in
 * that default, and the symptom is not an error: it is a model that answers as
 * though it had never been told the rules.
 */
export function toOllamaRequest(req: AnthropicRequest, opts: TranslateOptions): OllamaChatRequest {
  const messages: OllamaMessage[] = [];

  const system = flattenSystem(req.system);
  if (system) messages.push({ role: "system", content: system });

  // Ids minted by a previous response of ours. A tool_result naming anything
  // else cannot be placed, and guessing is worse than refusing — see below.
  const knownToolUseIds = new Set<string>();

  for (const msg of req.messages ?? []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = Array.isArray(msg.content) ? msg.content : [];
    const texts: string[] = [];
    const toolCalls: OllamaToolCall[] = [];
    const toolResults: OllamaMessage[] = [];

    for (const block of blocks) {
      switch (block.type) {
        case "text":
          texts.push((block as AnthropicTextBlock).text ?? "");
          break;

        case "tool_use": {
          const b = block as AnthropicToolUseBlock;
          knownToolUseIds.add(b.id);
          toolCalls.push({
            function: {
              name: b.name,
              arguments: (b.input && typeof b.input === "object" ? b.input : {}) as Record<string, unknown>,
            },
          });
          break;
        }

        case "tool_result": {
          const b = block as AnthropicToolResultBlock;
          // Ollama pairs a result with its call by position, not by id. That
          // works only while the ids we are given are ones we issued; an
          // unknown id means the ordering assumption has already broken, and
          // silently dropping the block yields a model answering as though the
          // tool never ran. Refuse instead.
          if (!knownToolUseIds.has(b.tool_use_id)) {
            throw new TranslationError(
              "invalid_request_error",
              `tool_result references unknown tool_use_id "${b.tool_use_id}"`,
            );
          }
          toolResults.push({ role: "tool", content: renderToolResultContent(b.content) });
          break;
        }

        case "image":
          opts.onDropped?.("image block");
          break;

        default:
          opts.onDropped?.(`${block.type} block`);
          break;
      }
    }

    // A turn's tool results are their own messages and must precede nothing:
    // they answer the assistant turn before them.
    if (texts.length || toolCalls.length) {
      const entry: OllamaMessage = { role: msg.role, content: texts.join("\n\n") };
      if (toolCalls.length) entry.tool_calls = toolCalls;
      messages.push(entry);
    }
    messages.push(...toolResults);
  }

  const options: Record<string, unknown> = { num_ctx: opts.numCtx };
  if (typeof req.max_tokens === "number") options.num_predict = req.max_tokens;
  if (typeof req.temperature === "number") options.temperature = req.temperature;
  if (typeof req.top_p === "number") options.top_p = req.top_p;
  if (req.stop_sequences?.length) options.stop = req.stop_sequences;

  const body: OllamaChatRequest = {
    model: opts.model,
    messages,
    stream: opts.stream,
    // The local model advertises a `thinking` capability. Reasoning is not an
    // answer, and letting it arrive means deciding at stream time whether each
    // fragment is one — so it is turned off at the source instead.
    think: false,
    options,
  };

  // `tool_choice: {type:"none"}` is the one value Ollama can honour, by not
  // being offered the tools at all. Anything else passes them and lets the
  // model decide, which is Ollama's only mode.
  const suppressed = req.tool_choice?.type === "none";
  if (req.tools?.length && !suppressed) {
    body.tools = req.tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description ?? "",
        // Anthropic's input_schema is already JSON Schema; it is Ollama's
        // `parameters` under a different name.
        parameters: t.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }

  return body;
}

// ─── Response: Ollama → Anthropic ────────────────────────────────────────────

let toolCounter = 0;

/** Anthropic tool ids are opaque; only their uniqueness within a turn matters. */
export function mintToolUseId(): string {
  toolCounter += 1;
  return `toolu_${toolCounter.toString(36)}${Math.floor(performance.now()).toString(36)}`;
}

export function stopReasonFor(hadToolCalls: boolean, doneReason?: string): StopReason {
  // Order matters: a turn that called a tool is `tool_use` whatever Ollama says
  // about why generation stopped. Claude Code drives its agent loop off this
  // field — reporting `end_turn` on a turn with tool calls ends the loop, and
  // looks like the model refusing to act.
  if (hadToolCalls) return "tool_use";
  if (doneReason === "length") return "max_tokens";
  return "end_turn";
}

/**
 * Rough token count for `/v1/messages/count_tokens`.
 *
 * Ollama exposes no tokeniser. Four characters per token is the usual English
 * approximation and is wrong for code and for Russian — it is an estimate, and
 * both this comment and the response say so. Answering 404 instead would be
 * worse: the client reads that as the request failing.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** Every piece of text a request would send, for the estimate above. */
export function requestText(req: AnthropicRequest): string {
  const parts: string[] = [flattenSystem(req.system)];
  for (const msg of req.messages ?? []) {
    if (typeof msg.content === "string") {
      parts.push(msg.content);
      continue;
    }
    for (const block of msg.content ?? []) {
      if (block.type === "text") parts.push((block as AnthropicTextBlock).text ?? "");
      else if (block.type === "tool_use") parts.push(JSON.stringify((block as AnthropicToolUseBlock).input ?? {}));
      else if (block.type === "tool_result") parts.push(renderToolResultContent((block as AnthropicToolResultBlock).content));
    }
  }
  for (const tool of req.tools ?? []) {
    parts.push(tool.name, tool.description ?? "", JSON.stringify(tool.input_schema ?? {}));
  }
  return parts.filter(Boolean).join("\n");
}

/** Assemble a non-streaming Anthropic response from Ollama's single reply. */
export function toAnthropicResponse(chunk: OllamaChunk, model: string): AnthropicResponse {
  const content: (AnthropicTextBlock | AnthropicToolUseBlock)[] = [];
  const text = chunk.message?.content ?? "";
  if (text) content.push({ type: "text", text });

  const calls = chunk.message?.tool_calls ?? [];
  for (const call of calls) {
    content.push({
      type: "tool_use",
      id: mintToolUseId(),
      name: call.function?.name ?? "",
      input: call.function?.arguments ?? {},
    });
  }

  // Anthropic responses always carry at least one block; an empty array is a
  // shape Claude Code does not expect.
  if (!content.length) content.push({ type: "text", text: "" });

  return {
    id: `msg_${mintToolUseId().slice(6)}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: stopReasonFor(calls.length > 0, chunk.done_reason),
    stop_sequence: null,
    usage: {
      input_tokens: chunk.prompt_eval_count ?? 0,
      output_tokens: chunk.eval_count ?? 0,
    },
  };
}

// ─── Streaming ───────────────────────────────────────────────────────────────

export interface SseEvent {
  event: string;
  data: unknown;
}

export function serializeSse(ev: SseEvent): string {
  return `event: ${ev.event}\ndata: ${JSON.stringify(ev.data)}\n\n`;
}

/**
 * Anthropic's streaming shape, driven by Ollama's chunks.
 *
 * A state machine rather than a transform stream so the event *order* — the
 * thing Claude Code parses and the thing that hangs it when wrong — is
 * assertable in a unit test without a socket.
 */
export class AnthropicStream {
  private index = -1;
  private textOpen = false;
  private toolCalls = 0;
  private outputTokens = 0;

  constructor(private readonly model: string) {}

  start(inputTokens = 0): SseEvent[] {
    return [
      {
        event: "message_start",
        data: {
          type: "message_start",
          message: {
            id: `msg_${mintToolUseId().slice(6)}`,
            type: "message",
            role: "assistant",
            model: this.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
          },
        },
      },
    ];
  }

  /** Translate one Ollama chunk. The final chunk goes to finish(). */
  chunk(c: OllamaChunk): SseEvent[] {
    const out: SseEvent[] = [];
    const text = c.message?.content ?? "";

    if (text) {
      if (!this.textOpen) {
        this.index += 1;
        this.textOpen = true;
        out.push({
          event: "content_block_start",
          data: { type: "content_block_start", index: this.index, content_block: { type: "text", text: "" } },
        });
      }
      out.push({
        event: "content_block_delta",
        data: { type: "content_block_delta", index: this.index, delta: { type: "text_delta", text } },
      });
    }

    for (const call of c.message?.tool_calls ?? []) {
      if (this.textOpen) {
        out.push({ event: "content_block_stop", data: { type: "content_block_stop", index: this.index } });
        this.textOpen = false;
      }
      this.index += 1;
      this.toolCalls += 1;
      out.push({
        event: "content_block_start",
        data: {
          type: "content_block_start",
          index: this.index,
          content_block: { type: "tool_use", id: mintToolUseId(), name: call.function?.name ?? "", input: {} },
        },
      });
      // Ollama hands over a finished argument object, not a token stream, so the
      // whole JSON goes in one delta. That is legal and beats faking increments.
      out.push({
        event: "content_block_delta",
        data: {
          type: "content_block_delta",
          index: this.index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(call.function?.arguments ?? {}) },
        },
      });
      out.push({ event: "content_block_stop", data: { type: "content_block_stop", index: this.index } });
    }

    return out;
  }

  finish(final: OllamaChunk): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.textOpen) {
      out.push({ event: "content_block_stop", data: { type: "content_block_stop", index: this.index } });
      this.textOpen = false;
    }
    // A turn that produced nothing still needs one block: Claude Code reads
    // content[0] unconditionally.
    if (this.index < 0) {
      out.push({
        event: "content_block_start",
        data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      });
      out.push({ event: "content_block_stop", data: { type: "content_block_stop", index: 0 } });
      this.index = 0;
    }
    this.outputTokens = final.eval_count ?? this.outputTokens;
    out.push({
      event: "message_delta",
      data: {
        type: "message_delta",
        delta: { stop_reason: stopReasonFor(this.toolCalls > 0, final.done_reason), stop_sequence: null },
        usage: { output_tokens: this.outputTokens },
      },
    });
    out.push({ event: "message_stop", data: { type: "message_stop" } });
    return out;
  }
}

// ─── Model resolution ────────────────────────────────────────────────────────

/**
 * Pick the Ollama model to run.
 *
 * Deliberately loose. `resolveProviderEnv()` exports one model name, but Claude
 * Code sends others: background work — titles, small classifications — goes to
 * a small/fast model whose id the client chooses itself, and this host has
 * never pulled it. Resolving strictly would produce the worst failure available
 * here — a session that mostly works, with parts of it failing for reasons that
 * never reach the operator.
 */
export function resolveModel(requested: string | undefined, available: string[], fallback: string): string {
  const want = (requested ?? "").trim();
  if (!want) return fallback;
  if (available.includes(want)) return want;
  // Ollama names carry a tag; Claude Code passes the name it was given, which
  // may omit `:latest`.
  const tagged = available.find((m) => m === `${want}:latest` || m.split(":")[0] === want);
  return tagged ?? fallback;
}

/** Ollama `/api/tags` → the body `parseModelsResponse()` in provider-service accepts. */
export function toModelsResponse(tags: { models?: { name?: string; model?: string }[] }): {
  data: { id: string; display_name: string }[];
} {
  const names = (tags.models ?? [])
    .map((m) => m.model ?? m.name ?? "")
    .filter((n): n is string => Boolean(n));
  return { data: names.map((id) => ({ id, display_name: id })) };
}
