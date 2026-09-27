/**
 * Pure Telegram HTTP helpers for the channel subprocess.
 * Leaf module — no imports from other channel/ modules.
 * All calls go through `telegramRequest` which handles retry on 429 and 5xx.
 */

import { channelLogger } from "../logger.ts";
import { acquireSendSlot, type SendPriority } from "../utils/telegram-rate-budget.ts";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_ERROR_RETRIES = 3;  // for network errors and 5xx only
const FETCH_TIMEOUT_MS = 10_000; // 10 s per individual fetch — prevents infinite hang
const MAX_TOTAL_MS = 60_000;     // 60 s total budget per call (covers 429 retries too)
// An upload carries a whole file, so the per-fetch cap a JSON send uses would
// turn a large document on a slow uplink into a false timeout.
const UPLOAD_FETCH_TIMEOUT_MS = 120_000;
const UPLOAD_TOTAL_MS = 300_000;  // total budget per upload, covering 429 retries

/** Low-level request with retry on 429 (rate limit) and 5xx errors.
 * Each fetch is capped at FETCH_TIMEOUT_MS.
 * Total call budget is MAX_TOTAL_MS — returns error if exceeded.
 * 429 retries wait retry_after but respect the total budget.
 * Network/5xx errors retry up to MAX_ERROR_RETRIES times.
 */
/**
 * A deleted forum topic does not make Telegram reject a send. It accepts the
 * request, drops the thread and files the message in General — the failure mode
 * that silently emptied a project's topic into the hub. Every send goes through
 * here, so this is the one place that can notice the answer landed somewhere
 * other than where it was addressed.
 */
function reportThreadMiss(method: string, body: Record<string, unknown>, result: unknown): void {
  const requested = body.message_thread_id;
  if (typeof requested !== "number") return;
  if (typeof result !== "object" || result === null) return;
  const sent = result as { message_id?: number; message_thread_id?: number };
  if (typeof sent.message_id !== "number") return; // not a message-producing method
  if (sent.message_thread_id === requested) return;
  channelLogger.error(
    { method, requestedThread: requested, landedIn: sent.message_thread_id ?? "General", messageId: sent.message_id },
    "telegram: message landed outside the requested topic — the topic was probably deleted; run /forum_clean",
  );
}

async function telegramRequest(
  token: string,
  method: string,
  body: Record<string, unknown>,
  priority: SendPriority = "priority",
): Promise<{ ok: boolean; result?: unknown; errorBody?: string; status?: number }> {
  let errorAttempt = 0;
  const deadline = Date.now() + MAX_TOTAL_MS;

  while (true) {
    if (Date.now() >= deadline) {
      return { ok: false, errorBody: `telegramRequest timeout after ${MAX_TOTAL_MS}ms (method: ${method})` };
    }

    // Shared cross-process gate (flow 064) — waits for the local lease
    // allowance rather than sending unconditionally. This runs before every
    // actual attempt, including 429/5xx retries, since each is a real
    // outbound call against the same shared per-chat budget. Bounded by this
    // call's own remaining deadline (same `remaining` shape the 429 branch
    // below computes) so a starved shared budget cannot hang this call past
    // its documented MAX_TOTAL_MS contract.
    try {
      await acquireSendSlot(deadline - Date.now(), priority);
    } catch {
      return {
        ok: false,
        errorBody: `telegramRequest timeout after ${MAX_TOTAL_MS}ms waiting for a rate-limit slot (method: ${method})`,
      };
    }

    let res: Response;
    try {
      res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (errorAttempt >= MAX_ERROR_RETRIES) return { ok: false, errorBody: String(err) };
      await Bun.sleep(1000 * (errorAttempt + 1));
      errorAttempt++;
      continue;
    }

    if (res.ok) {
      const data = (await res.json()) as { ok: boolean; result?: unknown };
      reportThreadMiss(method, body, data.result);
      return { ok: true, result: data.result };
    }

    // Rate limit — wait retry_after but respect total deadline
    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
      const wait = (data.parameters?.retry_after ?? 5) * 1000;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { ok: false, errorBody: `telegramRequest 429 deadline exceeded (method: ${method})` };
      channelLogger.warn({ method, wait, remaining }, "Telegram rate limit — retrying");
      await Bun.sleep(Math.min(wait, remaining));
      continue;
    }

    // Server error — retry with backoff up to MAX_ERROR_RETRIES
    if (res.status >= 500 && errorAttempt < MAX_ERROR_RETRIES) {
      await Bun.sleep(1000 * (errorAttempt + 1));
      errorAttempt++;
      continue;
    }

    const errorBody = await res.text().catch(() => String(res.status));
    return { ok: false, errorBody, status: res.status };
  }
}

/**
 * Multipart upload — the only path that sends bytes rather than a JSON body.
 *
 * It shares `telegramRequest`'s contract rather than calling `fetch` directly,
 * and that is the point: the same cross-process rate budget (flow 064), the
 * same 429/5xx retry shape, and the same `reportThreadMiss` check that catches
 * a send filed into General because the topic it named had been deleted. A
 * bare `fetch` gets none of the three.
 */
async function telegramUpload(
  token: string,
  method: string,
  field: string,
  file: { bytes: ArrayBuffer; filename: string; mime: string },
  params: Record<string, unknown>,
  priority: SendPriority = "priority",
): Promise<{ ok: boolean; result?: unknown; errorBody?: string; status?: number }> {
  let errorAttempt = 0;
  const deadline = Date.now() + UPLOAD_TOTAL_MS;

  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return { ok: false, errorBody: `telegramUpload timeout after ${UPLOAD_TOTAL_MS}ms (method: ${method})` };
    }

    try {
      await acquireSendSlot(remaining, priority);
    } catch {
      return {
        ok: false,
        errorBody: `telegramUpload timeout after ${UPLOAD_TOTAL_MS}ms waiting for a rate-limit slot (method: ${method})`,
      };
    }

    // Rebuilt per attempt: a FormData body is consumed by the fetch it is
    // handed, so a retry that re-sent the same one would upload nothing.
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === "") continue;
      form.append(key, String(value));
    }
    form.append(field, new Blob([file.bytes], { type: file.mime }), file.filename);

    let res: Response;
    try {
      res = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(UPLOAD_FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      if (errorAttempt >= MAX_ERROR_RETRIES) return { ok: false, errorBody: String(err) };
      await Bun.sleep(1000 * (errorAttempt + 1));
      errorAttempt++;
      continue;
    }

    if (res.ok) {
      const data = (await res.json()) as { ok: boolean; result?: unknown };
      reportThreadMiss(method, params, data.result);
      return { ok: true, result: data.result };
    }

    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as { parameters?: { retry_after?: number } };
      const wait = (data.parameters?.retry_after ?? 5) * 1000;
      const left = deadline - Date.now();
      if (left <= 0) return { ok: false, errorBody: `telegramUpload 429 deadline exceeded (method: ${method})` };
      channelLogger.warn({ method, wait, remaining: left }, "Telegram rate limit — retrying upload");
      await Bun.sleep(Math.min(wait, left));
      continue;
    }

    if (res.status >= 500 && errorAttempt < MAX_ERROR_RETRIES) {
      await Bun.sleep(1000 * (errorAttempt + 1));
      errorAttempt++;
      continue;
    }

    const errorBody = await res.text().catch(() => String(res.status));
    return { ok: false, errorBody, status: res.status };
  }
}

// --- Public helpers ---

export async function sendTelegramMessage(
  token: string,
  chatId: string,
  text: string,
  extra?: Record<string, unknown>,
  /** "background" for status/progress traffic (channel/status.ts) — see telegram-rate-budget.ts. Defaults to "priority", same as before this parameter existed. */
  priority?: SendPriority,
): Promise<{ ok: boolean; messageId: number | null; errorBody?: string }> {
  const res = await telegramRequest(token, "sendMessage", {
    chat_id: Number(chatId),
    text,
    ...extra,
  }, priority);
  if (!res.ok) return { ok: false, messageId: null, errorBody: res.errorBody };
  const result = res.result as { message_id?: number } | undefined;
  return { ok: true, messageId: result?.message_id ?? null };
}

export async function editTelegramMessage(
  token: string,
  chatId: string,
  messageId: number,
  text: string,
  extra?: Record<string, unknown>,
  /** "background" for status/progress traffic (channel/status.ts) — see telegram-rate-budget.ts. Defaults to "priority", same as before this parameter existed. */
  priority?: SendPriority,
): Promise<{ ok: boolean; errorBody?: string }> {
  return telegramRequest(token, "editMessageText", {
    chat_id: Number(chatId),
    message_id: messageId,
    text,
    ...extra,
  }, priority);
}

export function deleteTelegramMessage(
  token: string,
  chatId: string,
  messageId: number,
  /** "background" for routine status-message cleanup (channel/status.ts) — see telegram-rate-budget.ts. Defaults to "priority", same as before this parameter existed. */
  priority?: SendPriority,
): void {
  telegramRequest(token, "deleteMessage", {
    chat_id: Number(chatId),
    message_id: messageId,
  }, priority).catch(() => {});
}

export async function sendTelegramPoll(
  token: string,
  chatId: string,
  question: string,
  options: string[],
  extra?: Record<string, unknown>,
): Promise<{ ok: boolean; pollId?: string; messageId?: number; errorBody?: string }> {
  const res = await telegramRequest(token, "sendPoll", {
    chat_id: Number(chatId),
    question,
    options: options.map((text) => ({ text })),
    is_anonymous: false,
    ...extra,
  });
  if (!res.ok) return { ok: false, errorBody: res.errorBody };
  const result = res.result as { message_id?: number; poll?: { id?: string } } | undefined;
  return { ok: true, messageId: result?.message_id ?? undefined, pollId: result?.poll?.id ?? undefined };
}

export async function sendTelegramPhoto(
  token: string,
  chatId: string,
  photo: string, // public URL or absolute local file path
  caption?: string,
  extra?: Record<string, unknown>,
): Promise<{ ok: boolean; messageId: number | null; errorBody?: string }> {
  // Local file — upload via multipart form data
  if (photo.startsWith("/")) {
    const file = Bun.file(photo);
    if (!(await file.exists())) return { ok: false, messageId: null, errorBody: `File not found: ${photo}` };
    const bytes = await file.arrayBuffer();
    const mime = file.type || "image/jpeg";
    const form = new FormData();
    form.append("chat_id", String(Number(chatId)));
    form.append("photo", new Blob([bytes], { type: mime }), "photo");
    if (caption) form.append("caption", caption);
    if (extra?.message_thread_id) form.append("message_thread_id", String(extra.message_thread_id));
    let res: Response;
    try {
      res = await fetch(`${TELEGRAM_API}/bot${token}/sendPhoto`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      return { ok: false, messageId: null, errorBody: String(err) };
    }
    if (!res.ok) {
      const errorBody = await res.text().catch(() => String(res.status));
      return { ok: false, messageId: null, errorBody };
    }
    const data = (await res.json()) as { ok: boolean; result?: { message_id?: number } };
    return { ok: true, messageId: data.result?.message_id ?? null };
  }

  // Remote URL — pass directly to Telegram
  const res = await telegramRequest(token, "sendPhoto", {
    chat_id: Number(chatId),
    photo,
    ...(caption ? { caption } : {}),
    ...extra,
  });
  if (!res.ok) return { ok: false, messageId: null, errorBody: res.errorBody };
  const result = res.result as { message_id?: number } | undefined;
  return { ok: true, messageId: result?.message_id ?? null };
}

/**
 * Send a local file as a Telegram **document** — the path a PDF needs.
 *
 * `sendPhoto` is for images. A PDF uploaded there is accepted and acknowledged
 * with a message id, and the recipient still does not get a file they can
 * open; the bytes land and nothing usable arrives. `sendDocument` carries the
 * file's own base name, so what lands is `next-sprint-plan.pdf` rather than a
 * nameless attachment.
 *
 * A missing or empty file is a failure here rather than an upload, so no
 * caller ever reads "sent" for something Telegram received as zero bytes.
 */
export async function sendTelegramDocument(
  token: string,
  chatId: string,
  documentPath: string,
  caption?: string,
  extra?: Record<string, unknown>,
): Promise<{ ok: boolean; messageId: number | null; errorBody?: string }> {
  // Telegram's media caption limit. Checked here rather than left to the API so
  // the caller gets a reason instead of an opaque 400.
  if (caption && caption.length > 1024) {
    return {
      ok: false,
      messageId: null,
      errorBody: `Caption is ${caption.length} characters; Telegram's limit for a document caption is 1024`,
    };
  }

  const file = Bun.file(documentPath);
  if (!(await file.exists())) {
    return { ok: false, messageId: null, errorBody: `File not found: ${documentPath}` };
  }
  const bytes = await file.arrayBuffer();
  if (bytes.byteLength === 0) {
    return { ok: false, messageId: null, errorBody: `File is empty: ${documentPath}` };
  }

  const filename = documentPath.split("/").pop() || "document";
  const res = await telegramUpload(
    token,
    "sendDocument",
    "document",
    { bytes, filename, mime: file.type || "application/octet-stream" },
    { chat_id: Number(chatId), caption, ...extra },
  );
  if (!res.ok) return { ok: false, messageId: null, errorBody: res.errorBody };
  const result = res.result as { message_id?: number } | undefined;
  return { ok: true, messageId: result?.message_id ?? null };
}

/**
 * Telegram's GFM parser requires explicit alignment colons in table separators.
 * Standard GFM allows |---|---| (left-align is the default), but Telegram only
 * recognises rows that contain at least one colon, e.g. |:---|:---:|---:|.
 * This function rewrites bare separator rows like |---|---| → |:---|:---|.
 */
function preprocessRichMarkdown(markdown: string): string {
  return markdown.replace(
    /^(\|[ \t]*:?-+:?[ \t]*)+\|[ \t]*$/gm,
    (line) => line.replace(/\|([ \t]*)(:?)([-]+)(:?)([ \t]*)/g, (_, s1, lc, dashes, rc, s2) =>
      `|${s1}${lc || ":"}${dashes}${rc}${s2}`
    ),
  );
}

export async function sendRichTelegramMessage(
  token: string,
  chatId: string,
  markdown: string,
  extra?: Record<string, unknown>,
): Promise<{ ok: boolean; messageId: number | null; errorBody?: string }> {
  const res = await telegramRequest(token, "sendRichMessage", {
    chat_id: Number(chatId),
    rich_message: { markdown: preprocessRichMarkdown(markdown) },
    ...extra,
  });
  if (!res.ok) return { ok: false, messageId: null, errorBody: res.errorBody };
  const result = res.result as { message_id?: number } | undefined;
  return { ok: true, messageId: result?.message_id ?? null };
}

export async function editRichTelegramMessage(
  token: string,
  chatId: string,
  messageId: number,
  markdown: string,
  extra?: Record<string, unknown>,
): Promise<{ ok: boolean; errorBody?: string }> {
  return telegramRequest(token, "editMessageText", {
    chat_id: Number(chatId),
    message_id: messageId,
    rich_message: { markdown: preprocessRichMarkdown(markdown) },
    ...extra,
  });
}

export async function setTelegramReaction(
  token: string,
  chatId: string,
  messageId: number,
  emoji: string,
): Promise<{ ok: boolean; errorBody?: string }> {
  const res = await telegramRequest(token, "setMessageReaction", {
    chat_id: Number(chatId),
    message_id: messageId,
    reaction: [{ type: "emoji", emoji }],
  });
  return { ok: res.ok, errorBody: res.errorBody };
}

/** priority: see deleteTelegramMessage's doc — same default, same "background" for routine status housekeeping. */
export function pinTelegramMessage(token: string, chatId: string, messageId: number, priority?: SendPriority): void {
  telegramRequest(token, "pinChatMessage", {
    chat_id: Number(chatId),
    message_id: messageId,
    disable_notification: true,
  }, priority).catch(() => {});
}

/** priority: see deleteTelegramMessage's doc — same default, same "background" for routine status housekeeping. */
export function unpinTelegramMessage(token: string, chatId: string, messageId: number, priority?: SendPriority): void {
  telegramRequest(token, "unpinChatMessage", {
    chat_id: Number(chatId),
    message_id: messageId,
  }, priority).catch(() => {});
}
