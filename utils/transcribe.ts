const WHISPER_URL = process.env.WHISPER_URL ?? "http://localhost:9000";
const WHISPER_TIMEOUT_MS = 60000;

export async function transcribe(
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

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), WHISPER_TIMEOUT_MS);

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
    const text = data.text?.trim();
    return text || null;
  } catch (err) {
    console.error(`[transcribe] failed:`, err);
    return null;
  }
}
