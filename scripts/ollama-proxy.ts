#!/usr/bin/env bun
/**
 * ollama-proxy — an Anthropic Messages endpoint in front of the local Ollama.
 *
 * Claude Code speaks Anthropic and Ollama has no such route, so a project can
 * register every cloud backend and not the model running on its own machine.
 * This daemon closes that gap by translating, and by translating *here*: the
 * off-the-shelf routers configure the machine, and on 2026-08-07 one of them
 * wrote a base URL into ~/.claude/settings.json and stopped every Claude Code
 * session on this host from starting.
 *
 * So the contract is narrow on purpose:
 *   - it reads no Claude Code configuration and writes none;
 *   - it is selected through an ordinary `providers` row, per project, exactly
 *     like DeepSeek — no new mechanism, and the same blast radius as before;
 *   - it binds 127.0.0.1 and nothing else. That is the whole access control,
 *     and binding wider is a defect, not an option.
 *
 * Usage: bun scripts/ollama-proxy.ts   (started by cli.ts when enabled)
 * Specification: docs/requirements/ollama-provider-2026-08-07/prd.md
 */

import { CONFIG } from "../config.ts";
import {
  AnthropicStream,
  TranslationError,
  errorBody,
  estimateTokens,
  requestText,
  resolveModel,
  serializeSse,
  toAnthropicResponse,
  toModelsResponse,
  toOllamaRequest,
  type AnthropicRequest,
  type OllamaChunk,
} from "../utils/anthropic-ollama.ts";

const HOST = "127.0.0.1";
const HEARTBEAT_MS = 30_000;
const JSON_HEADERS = { "content-type": "application/json" };

/** Context lengths, per model. One `/api/show` per model, then never again. */
const ctxCache = new Map<string, number>();
/** Model names already reported as substituted, so a background call logs once. */
const substituted = new Set<string>();

function log(msg: string): void {
  console.log(`[ollama-proxy] ${msg}`);
}

async function ollamaFetch(path: string, init?: RequestInit): Promise<Response> {
  const base = CONFIG.OLLAMA_URL.replace(/\/+$/, "");
  return fetch(`${base}${path}`, init);
}

/**
 * The model's real context length.
 *
 * Read from the model itself rather than assumed: Ollama does not default to it,
 * and on this host neither the Modelfile nor ollama.service supplies one. The
 * fallback is deliberately small — if we cannot learn the window, sending a
 * large one would let the server truncate silently, which is the failure this
 * whole lookup exists to avoid.
 */
export async function contextLengthFor(model: string): Promise<number> {
  const cached = ctxCache.get(model);
  if (cached) return cached;

  let length = 8192;
  try {
    const res = await ollamaFetch("/api/show", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ model }),
    });
    if (res.ok) {
      const info = (await res.json()) as { model_info?: Record<string, unknown> };
      const entry = Object.entries(info.model_info ?? {}).find(([k]) => k.endsWith(".context_length"));
      if (typeof entry?.[1] === "number" && entry[1] > 0) length = entry[1] as number;
    }
  } catch {
    // Unreachable here is not fatal — the request that follows will report it.
  }
  ctxCache.set(model, length);
  return length;
}

async function availableModels(): Promise<string[]> {
  try {
    const res = await ollamaFetch("/api/tags");
    if (!res.ok) return [];
    const body = (await res.json()) as { models?: { name?: string; model?: string }[] };
    return (body.models ?? []).map((m) => m.model ?? m.name ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

/** Which model actually runs, plus a one-line note the first time it differs. */
async function pickModel(requested: string | undefined): Promise<string> {
  const fallback = CONFIG.OLLAMA_PROXY_MODEL || CONFIG.OLLAMA_CHAT_MODEL;
  const models = await availableModels();
  const chosen = resolveModel(requested, models, fallback);
  if (requested && chosen !== requested && !substituted.has(requested)) {
    substituted.add(requested);
    log(`model "${requested}" is not pulled here — serving it with "${chosen}"`);
  }
  return chosen;
}

function fail(err: unknown): Response {
  if (err instanceof TranslationError) {
    return new Response(errorBody(err.errorType, err.message), { status: err.status, headers: JSON_HEADERS });
  }
  const message = err instanceof Error ? err.message : String(err);
  return new Response(errorBody("api_error", message), { status: 502, headers: JSON_HEADERS });
}

/** Split a chunked `/api/chat` body into whole JSON objects, one per line. */
function* parseNdjson(buffer: string): Generator<OllamaChunk> {
  for (const line of buffer.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      yield JSON.parse(trimmed) as OllamaChunk;
    } catch {
      // A split mid-object: the caller keeps the remainder for the next read.
    }
  }
}

async function handleMessages(req: Request): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = (await req.json()) as AnthropicRequest;
  } catch {
    return fail(new TranslationError("invalid_request_error", "request body is not JSON"));
  }
  if (!Array.isArray(body.messages)) {
    return fail(new TranslationError("invalid_request_error", "messages must be an array"));
  }

  const model = await pickModel(body.model);
  const numCtx = await contextLengthFor(model);
  const stream = body.stream !== false;

  let ollamaBody: ReturnType<typeof toOllamaRequest>;
  try {
    ollamaBody = toOllamaRequest(body, {
      model,
      numCtx,
      stream,
      onDropped: (what) => log(`dropped ${what} — not representable in Ollama's chat API`),
    });
  } catch (err) {
    return fail(err);
  }

  let upstream: Response;
  try {
    upstream = await ollamaFetch("/api/chat", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(ollamaBody),
    });
  } catch (err) {
    return fail(
      new TranslationError(
        "api_error",
        `cannot reach Ollama at ${CONFIG.OLLAMA_URL}: ${err instanceof Error ? err.message : String(err)}`,
        502,
      ),
    );
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    return new Response(
      errorBody("api_error", `Ollama returned ${upstream.status}${detail ? `: ${detail.slice(0, 500)}` : ""}`),
      { status: upstream.status === 404 ? 404 : 502, headers: JSON_HEADERS },
    );
  }

  if (!stream) {
    const chunk = (await upstream.json()) as OllamaChunk;
    return Response.json(toAnthropicResponse(chunk, model));
  }

  const translator = new AnthropicStream(model);
  const encoder = new TextEncoder();
  const reader = upstream.body?.getReader();

  const sse = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (events: ReturnType<AnthropicStream["chunk"]>) => {
        for (const ev of events) controller.enqueue(encoder.encode(serializeSse(ev)));
      };
      try {
        emit(translator.start());
        let pending = "";
        let last: OllamaChunk = {};
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          pending += new TextDecoder().decode(value, { stream: true });
          const lastBreak = pending.lastIndexOf("\n");
          if (lastBreak === -1) continue;
          const ready = pending.slice(0, lastBreak);
          pending = pending.slice(lastBreak + 1);
          for (const chunk of parseNdjson(ready)) {
            if (chunk.done) last = chunk;
            else emit(translator.chunk(chunk));
          }
        }
        for (const chunk of parseNdjson(pending)) {
          if (chunk.done) last = chunk;
          else emit(translator.chunk(chunk));
        }
        emit(translator.finish(last));
      } catch (err) {
        // Mid-stream the status is already sent, so the only way to say
        // anything is an error event in the stream itself.
        controller.enqueue(
          encoder.encode(
            serializeSse({
              event: "error",
              data: { type: "error", error: { type: "api_error", message: err instanceof Error ? err.message : String(err) } },
            }),
          ),
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(sse, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

async function handleCountTokens(req: Request): Promise<Response> {
  let body: AnthropicRequest;
  try {
    body = (await req.json()) as AnthropicRequest;
  } catch {
    return fail(new TranslationError("invalid_request_error", "request body is not JSON"));
  }
  // An estimate, and said so out loud: Ollama exposes no tokeniser. Answering
  // 404 would be read by the client as the request failing.
  return Response.json({ input_tokens: estimateTokens(requestText(body)), estimated: true });
}

async function handleModels(): Promise<Response> {
  const res = await ollamaFetch("/api/tags").catch(() => null);
  if (!res?.ok) return fail(new TranslationError("api_error", `cannot reach Ollama at ${CONFIG.OLLAMA_URL}`, 502));
  return Response.json(toModelsResponse((await res.json()) as Parameters<typeof toModelsResponse>[0]));
}

export async function route(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, "") || "/";

  if (path === "/health") return Response.json({ status: "ok", model: CONFIG.OLLAMA_PROXY_MODEL || CONFIG.OLLAMA_CHAT_MODEL });
  if (path === "/v1/models" || path === "/models") return handleModels();
  if (path === "/v1/messages/count_tokens") return handleCountTokens(req);
  if (path === "/v1/messages") return handleMessages(req);

  // Named, not generic: the message reaches a terminal, and "404" alone sends
  // the operator looking in the wrong place.
  return new Response(errorBody("not_found_error", `no route ${path} — this proxy serves /v1/messages`), {
    status: 404,
    headers: JSON_HEADERS,
  });
}

async function heartbeat(startedAt: number, port: number): Promise<void> {
  try {
    const { sql } = await import("../memory/db.ts");
    await sql`
      INSERT INTO process_health (name, status, detail, updated_at)
      VALUES ('ollama-proxy', 'running', ${sql.json({ pid: process.pid, port, uptime_ms: Date.now() - startedAt })}, now())
      ON CONFLICT (name) DO UPDATE SET status = 'running', detail = EXCLUDED.detail, updated_at = now()
    `;
  } catch {
    // A database that is unreachable must not take the proxy down with it: a
    // session in flight matters more than a row in a health table.
  }
}

if (import.meta.main) {
  const port = CONFIG.OLLAMA_PROXY_PORT;
  const startedAt = Date.now();

  try {
    Bun.serve({ hostname: HOST, port, idleTimeout: 0, fetch: route });
  } catch (err) {
    // Never drift to another port: a `providers` row already names this one, so
    // a proxy listening elsewhere is a proxy nobody reaches.
    console.error(`[ollama-proxy] cannot bind ${HOST}:${port} — ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  log(`listening on http://${HOST}:${port} → ${CONFIG.OLLAMA_URL}`);
  await heartbeat(startedAt, port);
  setInterval(() => void heartbeat(startedAt, port), HEARTBEAT_MS);
}
