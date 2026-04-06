import { CONFIG } from "../config.ts";

const EMBED_RETRIES = 2;
const EMBED_RETRY_MS = 1500;

async function fetchEmbed(input: string | string[]): Promise<number[][]> {
  let lastErr: Error | undefined;
  for (let attempt = 0; attempt <= EMBED_RETRIES; attempt++) {
    try {
      const res = await fetch(`${CONFIG.OLLAMA_URL}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: CONFIG.EMBEDDING_MODEL, input }),
      });

      if (!res.ok) {
        throw new Error(`Ollama embed failed: ${res.status} ${await res.text()}`);
      }

      const data = (await res.json()) as { embeddings: number[][] };
      return data.embeddings;
    } catch (err: any) {
      lastErr = err;
      if (attempt < EMBED_RETRIES) {
        console.warn(`[embed] retry ${attempt + 1}/${EMBED_RETRIES}: ${err?.message}`);
        await new Promise((r) => setTimeout(r, EMBED_RETRY_MS * (attempt + 1)));
      }
    }
  }
  throw lastErr;
}

export async function embed(text: string): Promise<number[]> {
  const embeddings = await fetchEmbed(text);
  return embeddings[0];
}

export async function embedBatch(texts: string[]): Promise<number[][]> {
  return fetchEmbed(texts);
}

/**
 * Try to embed text, return null on failure instead of throwing.
 * Use when embedding is optional (e.g., summarization — better to store without vector than lose the data).
 */
export async function embedSafe(text: string): Promise<number[] | null> {
  try {
    return await embed(text);
  } catch (err) {
    console.error("[embed] failed after retries, returning null:", (err as Error)?.message);
    return null;
  }
}
