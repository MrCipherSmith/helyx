import type { Bot } from "grammy";
import { InputFile } from "grammy";
import { join } from "path";
import { CONFIG } from "../config.ts";
import { channelLogger } from "../logger.ts";

const GROQ_API_KEY = CONFIG.GROQ_API_KEY;
// OpenAI TTS key — read directly since config merges it into OPENROUTER_API_KEY
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? "";

// Piper local TTS — binary and model relative to this file's project root
const PIPER_DIR = join(import.meta.dir, "../piper");
const PIPER_BIN = join(PIPER_DIR, "piper/piper");
const PIPER_MODEL = join(PIPER_DIR, "voices/ru_RU-irina-medium.onnx");

const VOICE_MIN_CHARS = 200;

/**
 * Returns true if the text qualifies for a voice attachment:
 * - At least 200 chars
 * - Not mostly code (fenced code blocks < 40% of text length)
 * - Not a diff (fewer than 6 lines starting with + or -)
 */
export function shouldSendVoice(text: string): boolean {
  if (text.length < VOICE_MIN_CHARS) return false;

  // Count characters inside fenced code blocks
  let codeChars = 0;
  for (const m of text.matchAll(/```[\s\S]*?```/g)) {
    codeChars += m[0].length;
  }
  if (codeChars / text.length > 0.4) return false;

  // Detect diffs: lines starting with + or - (but not --- / +++ headers)
  const diffLines = text.split("\n").filter((l) => /^[+\-][^+\-]/.test(l)).length;
  if (diffLines >= 6) return false;

  return true;
}

/** Strip markdown formatting for cleaner TTS output */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "")          // code blocks → remove entirely
    .replace(/`[^`]+`/g, "")                 // inline code → remove
    .replace(/^#{1,6}\s+/gm, "")             // headings
    .replace(/\*\*([^*]+)\*\*/g, "$1")       // bold
    .replace(/\*([^*]+)\*/g, "$1")           // italic *
    .replace(/_([^_]+)_/g, "$1")             // italic _
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links → keep label only
    .replace(/^\s*[-*+]\s+/gm, "")           // unordered list bullets
    .replace(/^\s*\d+\.\s+/gm, "")           // ordered list numbers
    .replace(/\n{3,}/g, "\n\n")              // collapse excessive blank lines
    .trim();
}

/** Synthesize via local Piper TTS (Russian, offline, free). Returns WAV buffer. */
async function synthesizePiper(text: string): Promise<Buffer | null> {
  const tmpFile = `/tmp/piper-tts-${Date.now()}.wav`;
  try {
    const proc = Bun.spawn(
      [PIPER_BIN, "--model", PIPER_MODEL, "--output_file", tmpFile],
      { stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "ignore" },
    );
    const code = await proc.exited;
    if (code !== 0) {
      channelLogger.error({ code }, "tts: Piper exited with error");
      return null;
    }
    const buf = await Bun.file(tmpFile).arrayBuffer();
    return Buffer.from(buf);
  } catch (err) {
    channelLogger.error({ err }, "tts: Piper spawn failed");
    return null;
  } finally {
    Bun.file(tmpFile).exists().then(exists => {
      if (exists) Bun.spawnSync(["rm", "-f", tmpFile]);
    }).catch(() => {});
  }
}

/** Synthesize via Groq Orpheus (English only — best available Groq TTS as of 2026). */
async function synthesizeGroq(text: string): Promise<Buffer | null> {
  if (!GROQ_API_KEY) return null;

  const res = await fetch("https://api.groq.com/openai/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GROQ_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "canopylabs/orpheus-v1-english",
      input: text.slice(0, 4000),
      voice: "autumn",
      response_format: "wav",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    channelLogger.error({ status: res.status, err }, "tts: Groq error");
    return null;
  }

  return Buffer.from(await res.arrayBuffer());
}

/** Synthesize via OpenAI TTS (tts-1, multilingual, auto language detect). */
async function synthesizeOpenAI(text: string): Promise<Buffer | null> {
  if (!OPENAI_API_KEY) return null;

  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "tts-1",
      input: text.slice(0, 4096),
      voice: "nova",
      response_format: "mp3",
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    channelLogger.error({ status: res.status, err }, "tts: OpenAI error");
    return null;
  }

  return Buffer.from(await res.arrayBuffer());
}

/**
 * Convert text to speech.
 * Priority: OpenAI (multilingual, if key set) → Piper (local, Russian) → Groq (English only).
 * Returns WAV buffer or null on failure/disabled.
 */
export async function synthesize(text: string): Promise<Buffer | null> {
  const clean = stripMarkdown(text);
  if (clean.length < 10) return null;

  // OpenAI first — best multilingual support
  if (OPENAI_API_KEY) {
    try {
      const buf = await synthesizeOpenAI(clean);
      if (buf) return buf;
    } catch (err) {
      channelLogger.warn({ err }, "tts: OpenAI failed, trying Piper");
    }
  }

  // Piper — local, free, good Russian
  try {
    const buf = await synthesizePiper(clean);
    if (buf) return buf;
  } catch (err) {
    channelLogger.warn({ err }, "tts: Piper failed, trying Groq");
  }

  // Groq — English only, last resort
  try {
    return await synthesizeGroq(clean);
  } catch (err) {
    channelLogger.error({ err }, "tts: all providers failed");
    return null;
  }
}

/**
 * Fire-and-forget: if text qualifies for voice, generate TTS and send
 * as a Telegram voice message (MP3). Does not block the caller.
 */
export function maybeAttachVoice(
  bot: Bot,
  chatId: number | string,
  text: string,
  threadId?: number | null,
): void {
  if (!shouldSendVoice(text)) return;

  const opts = threadId ? { message_thread_id: threadId } : undefined;

  synthesize(text)
    .then((buf) => {
      if (!buf) return;
      return bot.api.sendVoice(Number(chatId), new InputFile(buf, "voice.wav"), opts);
    })
    .catch((err) => channelLogger.error({ err }, "tts: failed to send voice"));
}

/**
 * Same as maybeAttachVoice but uses a raw bot token instead of a grammY Bot.
 * Used by the channel subprocess which doesn't have a Bot instance.
 */
export function maybeAttachVoiceRaw(
  token: string,
  chatId: number | string,
  text: string,
  threadId?: number | null,
): void {
  if (!shouldSendVoice(text)) return;

  // Show "recording voice..." indicator while synthesis is in progress.
  // Telegram clears chat actions after 5s, so repeat every 4s until done.
  const actionBody: Record<string, unknown> = {
    chat_id: String(chatId),
    action: "upload_voice",
  };
  if (threadId) actionBody.message_thread_id = threadId;
  const sendAction = () => fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(actionBody),
  }).catch(() => {});

  sendAction();
  const actionTimer = setInterval(sendAction, 4000);

  synthesize(text)
    .then(async (buf) => {
      clearInterval(actionTimer);
      if (!buf) return;
      const form = new FormData();
      form.append("chat_id", String(chatId));
      form.append("voice", new Blob([buf], { type: "audio/wav" }), "voice.wav");
      if (threadId) form.append("message_thread_id", String(threadId));
      channelLogger.info({ chatId, threadId, bufSize: buf.length }, "tts: sending voice");
      const res = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const err = await res.text();
        channelLogger.error({ status: res.status, err }, "tts: sendVoice failed");
      } else {
        channelLogger.info({ chatId, threadId }, "tts: voice sent ok");
      }
    })
    .catch((err) => {
      clearInterval(actionTimer);
      channelLogger.error({ err }, "tts: failed to send voice (raw)");
    });
}
