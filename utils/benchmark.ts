/**
 * Kesha benchmark utilities.
 * When KESHA_BENCHMARK=true, runs current and kesha pipelines in parallel,
 * reports per-message stats and logs results to logs/kesha-benchmark.jsonl.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { CONFIG } from "../config.ts";
import { channelLogger } from "../logger.ts";
import { transcribeGroq, transcribeLocal, transcribeKesha } from "./transcribe.ts";
import { synthesizeCurrentOnly, synthesizeKesha } from "./tts.ts";

export interface AsrBenchResult {
  provider: string;
  latencyMs: number;
  heapDeltaMB: number;
  rssDeltaMB: number;
  text: string | null;
  charCount: number;
  success: boolean;
  error?: string;
}

export interface TtsBenchResult {
  provider: string;
  latencyMs: number;
  heapDeltaMB: number;
  rssDeltaMB: number;
  fileSizeKB: number;
  fmt: string;
  success: boolean;
  error?: string;
}

export interface BenchmarkEntry {
  ts: string;
  audioDurationSec?: number;
  sessionId?: number | null;
  chatId?: string | null;
  asr: AsrBenchResult[];
  tts: TtsBenchResult[];
}

function memDelta(before: NodeJS.MemoryUsage, after: NodeJS.MemoryUsage) {
  const mb = (n: number) => Math.round(n / 1024 / 1024 * 100) / 100;
  return {
    heapDeltaMB: mb(after.heapUsed - before.heapUsed),
    rssDeltaMB: mb(after.rss - before.rss),
  };
}

async function runAsr(
  fn: () => Promise<string | null>,
  provider: string,
): Promise<AsrBenchResult> {
  const memBefore = process.memoryUsage();
  const t0 = Date.now();
  let text: string | null = null;
  let error: string | undefined;
  try {
    text = await fn();
  } catch (err: any) {
    error = err?.message ?? String(err);
  }
  const mem = memDelta(memBefore, process.memoryUsage());
  return {
    provider,
    latencyMs: Date.now() - t0,
    ...mem,
    text,
    charCount: text?.length ?? 0,
    success: text !== null,
    error,
  };
}

async function runTts(
  fn: () => Promise<{ buf: Buffer; fmt: string; provider?: string } | null>,
  provider: string,
): Promise<TtsBenchResult & { buf?: Buffer; fmt?: string }> {
  const memBefore = process.memoryUsage();
  const t0 = Date.now();
  let result: { buf: Buffer; fmt: string; provider?: string } | null = null;
  let error: string | undefined;
  try {
    result = await fn();
  } catch (err: any) {
    error = err?.message ?? String(err);
  }
  const mem = memDelta(memBefore, process.memoryUsage());
  return {
    provider: result?.provider ?? provider,
    latencyMs: Date.now() - t0,
    ...mem,
    fileSizeKB: result ? Math.round(result.buf.length / 1024) : 0,
    fmt: result?.fmt ?? "—",
    success: result !== null,
    error,
    buf: result?.buf,
  };
}

/** Run current + kesha ASR in parallel. Returns both results. */
export async function runAsrBenchmark(
  audioBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
): Promise<AsrBenchResult[]> {
  const [current, kesha] = await Promise.all([
    runAsr(async () => {
      const groq = await transcribeGroq(audioBuffer, fileName, mimeType);
      if (groq) return groq;
      return transcribeLocal(audioBuffer, fileName, mimeType);
    }, "groq→whisper"),
    runAsr(() => transcribeKesha(audioBuffer, fileName), "kesha"),
  ]);
  return [current, kesha];
}

/** Run current + kesha TTS in parallel. Returns both results including audio buffers. */
export async function runTtsBenchmark(
  text: string,
  isRussian: boolean,
): Promise<Array<TtsBenchResult & { buf?: Buffer }>> {
  const [current, kesha] = await Promise.all([
    runTts(() => synthesizeCurrentOnly(text, isRussian), "current"),
    runTts(async () => {
      const buf = await synthesizeKesha(text, isRussian);
      return buf ? { buf, fmt: "wav", provider: "kesha" } : null;
    }, "kesha"),
  ]);
  return [current, kesha];
}

/** Format ASR + TTS results into a human-readable Telegram message. */
export function formatBenchmarkReport(
  asr: AsrBenchResult[],
  tts: Array<TtsBenchResult & { buf?: Buffer }>,
): string {
  const lines: string[] = ["📊 <b>Kesha Benchmark</b>"];

  if (asr.length > 0) {
    lines.push("\n🎤 <b>ASR</b>");
    for (const r of asr) {
      const icon = r.success ? "✅" : "❌";
      const preview = r.text ? `"${r.text.slice(0, 50)}${r.text.length > 50 ? "…" : ""}"` : "(failed)";
      const heap = r.heapDeltaMB >= 0 ? `+${r.heapDeltaMB}` : `${r.heapDeltaMB}`;
      lines.push(
        `${icon} <code>${r.provider.padEnd(14)}</code> ${r.latencyMs}ms | heap ${heap}MB | ${r.charCount}ch\n   ${preview}`,
      );
    }
    const texts = asr.filter((r) => r.text).map((r) => r.text!.trim().toLowerCase());
    if (texts.length >= 2) {
      const match = texts[0] === texts[1];
      lines.push(`🔍 Match: ${match ? "✅ identical" : "⚠️ different"}`);
    }
  }

  if (tts.length > 0) {
    lines.push("\n🔊 <b>TTS</b>");
    for (const r of tts) {
      const icon = r.success ? "✅" : "❌";
      const heap = r.heapDeltaMB >= 0 ? `+${r.heapDeltaMB}` : `${r.heapDeltaMB}`;
      lines.push(
        `${icon} <code>${r.provider.padEnd(14)}</code> ${r.latencyMs}ms | heap ${heap}MB | ${r.fileSizeKB}KB ${r.fmt.toUpperCase()}`,
      );
    }
    // Winner
    const successTts = tts.filter((r) => r.success);
    if (successTts.length >= 2) {
      const fastest = successTts.reduce((a, b) => (a.latencyMs < b.latencyMs ? a : b));
      lines.push(`🏆 Faster: ${fastest.provider} (${fastest.latencyMs}ms)`);
    }
  }

  lines.push(`\n📁 <code>logs/kesha-benchmark.jsonl</code>`);
  return lines.join("\n");
}

const LOG_DIR = process.env.LOGS_DIR ?? "logs";
const LOG_FILE = `${LOG_DIR}/kesha-benchmark.jsonl`;

/** Append benchmark result to JSONL log file. */
export function appendBenchmarkLog(entry: BenchmarkEntry): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    channelLogger.warn({ err }, "benchmark: failed to write log");
  }
}

/** Detect Russian from text (same heuristic as tts.ts). */
export function detectRussian(text: string): boolean {
  const cyr = (text.match(/[\u0400-\u04FF]/g) ?? []).length;
  const lat = (text.match(/[a-zA-Z]/g) ?? []).length;
  const total = cyr + lat;
  return total === 0 ? true : cyr / total >= 0.4;
}

/** Send a Telegram message via raw HTTP (usable from fire-and-forget contexts). */
export async function sendTelegramText(
  token: string,
  chatId: string | number,
  text: string,
  threadId?: number | null,
): Promise<void> {
  const body: Record<string, unknown> = {
    chat_id: String(chatId),
    text,
    parse_mode: "HTML",
  };
  if (threadId) body.message_thread_id = threadId;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    channelLogger.warn({ err }, "benchmark: sendTelegramText failed");
  }
}

/** Send a voice buffer to Telegram via raw HTTP. */
export async function sendTelegramVoice(
  token: string,
  chatId: string | number,
  buf: Buffer,
  fmt: string,
  threadId?: number | null,
  caption?: string,
): Promise<void> {
  const mimeType = fmt === "mp3" ? "audio/mpeg" : "audio/wav";
  const filename = fmt === "mp3" ? "voice.mp3" : "voice.wav";
  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("voice", new Blob([buf.buffer as ArrayBuffer], { type: mimeType }), filename);
  if (threadId) form.append("message_thread_id", String(threadId));
  if (caption) form.append("caption", caption);
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
      method: "POST",
      body: form,
    });
  } catch (err) {
    channelLogger.warn({ err }, "benchmark: sendTelegramVoice failed");
  }
}
