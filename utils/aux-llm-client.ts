import { sql } from "../memory/db.ts";

export interface AuxLlmConfig {
  provider: "deepseek" | "ollama" | "openrouter";
  model: string;
  baseUrl?: string;
}

export interface AuxLlmResponse {
  content: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  durationMs: number;
}

export interface AuxLlmError {
  error: string;
  durationMs: number;
}

function getConfig(): AuxLlmConfig {
  const provider = (process.env.HELYX_AUX_LLM_PROVIDER ?? "deepseek") as AuxLlmConfig["provider"];
  let baseUrl: string | undefined;

  switch (provider) {
    case "deepseek":
      baseUrl = process.env.CUSTOM_OPENAI_BASE_URL ?? "https://api.deepseek.com";
      break;
    case "ollama":
      baseUrl = process.env.HELYX_OLLAMA_URL ?? "http://localhost:11434";
      break;
    case "openrouter":
      baseUrl = "https://openrouter.ai/api/v1";
      break;
  }

  const modelMap: Record<string, string> = {
    deepseek: "deepseek-chat",
    ollama: "llama3.1",
    openrouter: "anthropic/claude-3.5-sonnet",
  };

  return {
    provider,
    model: process.env.HELYX_AUX_LLM_MODEL ?? modelMap[provider],
    baseUrl,
  };
}

// USD per 1M tokens. Ollama runs locally → zero. OpenRouter is per-model and
// not centrally tracked here; default 0 surfaces in dashboards as "unknown
// cost" rather than crashing.
const PRICING_PER_1M: Record<AuxLlmConfig["provider"], { input: number; output: number }> = {
  deepseek: { input: 0.27, output: 1.1 },
  ollama: { input: 0, output: 0 },
  openrouter: { input: 0, output: 0 },
};

function computeCostUsd(provider: AuxLlmConfig["provider"], tokensIn: number, tokensOut: number): number {
  const p = PRICING_PER_1M[provider];
  if (!p) return 0;
  return (p.input * tokensIn + p.output * tokensOut) / 1_000_000;
}

export async function callAuxLlm(
  systemPrompt: string,
  userPrompt: string,
  purpose: string,
  relatedId?: number,
): Promise<AuxLlmResponse | AuxLlmError> {
  const config = getConfig();
  const startTime = Date.now();

  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.provider === "deepseek" ? { Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}` } : {}),
        ...(config.provider === "openrouter" ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 4096,
        temperature: 0.3,
      }),
    });

    const data = (await res.json()) as {
      choices?: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens: number; completion_tokens: number };
      error?: { message: string };
    };

    const durationMs = Date.now() - startTime;

    if (data.error) {
      await sql`
        INSERT INTO aux_llm_invocations (purpose, provider, model, tokens_in, tokens_out, duration_ms, status, error_message, related_id)
        VALUES (${purpose}, ${config.provider}, ${config.model}, 0, 0, ${durationMs}, 'error', ${data.error.message}, ${relatedId ?? null})
      `.catch((err) => console.warn("[aux-llm] log insert failed:", err));
      return { error: data.error.message, durationMs };
    }

    const content = data.choices?.[0]?.message?.content ?? "";
    const tokensIn = data.usage?.prompt_tokens ?? Math.floor((systemPrompt + userPrompt).length / 4);
    const tokensOut = data.usage?.completion_tokens ?? Math.floor(content.length / 4);
    const costUsd = computeCostUsd(config.provider, tokensIn, tokensOut);

    await sql`
      INSERT INTO aux_llm_invocations (purpose, provider, model, tokens_in, tokens_out, cost_usd, duration_ms, status, related_id)
      VALUES (${purpose}, ${config.provider}, ${config.model}, ${tokensIn}, ${tokensOut}, ${costUsd}, ${durationMs}, 'success', ${relatedId ?? null})
    `.catch((err) => console.warn("[aux-llm] log insert failed:", err));

    return { content, tokensIn, tokensOut, costUsd, durationMs };
  } catch (err) {
    const durationMs = Date.now() - startTime;
    const errorMsg = err instanceof Error ? err.message : String(err);

    await sql`
      INSERT INTO aux_llm_invocations (purpose, provider, model, tokens_in, tokens_out, duration_ms, status, error_message, related_id)
      VALUES (${purpose}, ${config.provider}, ${config.model}, 0, 0, ${durationMs}, 'error', ${errorMsg}, ${relatedId ?? null})
    `.catch((logErr) => console.warn("[aux-llm] log insert failed:", logErr));

    return { error: errorMsg, durationMs };
  }
}
