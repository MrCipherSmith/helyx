const GROQ_API_KEY = process.env.GROQ_API_KEY;
const WHISPER_URL = process.env.WHISPER_URL ?? "http://localhost:9000";
const TIMEOUT_MS = 60000;

/** Transcribe via Groq whisper-large-v3 API (primary) */
async function transcribeGroq(
  audioBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
): Promise<string | null> {
  if (!GROQ_API_KEY) return null;

  const form = new FormData();
  form.append(
    "file",
    new Blob([audioBuffer], { type: mimeType }),
    fileName,
  );
  form.append("model", "whisper-large-v3");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}` },
    body: form,
    signal: controller.signal,
  });

  clearTimeout(timeout);

  if (!res.ok) {
    console.error(`[transcribe] Groq error: ${res.status} ${await res.text()}`);
    return null;
  }

  const data = (await res.json()) as { text?: string };
  return data.text?.trim() || null;
}

/** Transcribe via local Whisper ASR (fallback) */
async function transcribeLocal(
  audioBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
): Promise<string | null> {
  const form = new FormData();
  form.append(
    "audio_file",
    new Blob([audioBuffer], { type: mimeType }),
    fileName,
  );

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const res = await fetch(
    `${WHISPER_URL}/asr?task=transcribe&output=json`,
    {
      method: "POST",
      body: form,
      signal: controller.signal,
    },
  );

  clearTimeout(timeout);

  if (!res.ok) {
    console.error(`[transcribe] Whisper error: ${res.status}`);
    return null;
  }

  const data = (await res.json()) as { text?: string };
  return data.text?.trim() || null;
}

/** Transcribe audio: Groq (primary) → local Whisper (fallback) */
export async function transcribe(
  audioBuffer: ArrayBuffer,
  fileName: string,
  mimeType: string,
): Promise<string | null> {
  try {
    const result = await transcribeGroq(audioBuffer, fileName, mimeType);
    if (result) {
      console.error(`[transcribe] Groq OK`);
      return result;
    }
  } catch (err) {
    console.error(`[transcribe] Groq failed:`, err);
  }

  try {
    console.error(`[transcribe] falling back to local Whisper`);
    const result = await transcribeLocal(audioBuffer, fileName, mimeType);
    if (result) {
      console.error(`[transcribe] local Whisper OK`);
      return result;
    }
  } catch (err) {
    console.error(`[transcribe] local Whisper failed:`, err);
  }

  return null;
}
