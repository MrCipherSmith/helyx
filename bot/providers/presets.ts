/**
 * Provider presets — Anthropic-compatible backends the operator can register
 * without typing a base URL by hand.
 *
 * A preset is a starting point, not a constraint: the add-flow prefills these
 * values and the operator can override any of them. `Custom` exists so an
 * endpoint nobody anticipated is still one flow away.
 *
 * `models` are suggestions shown in the model picker. They go stale as vendors
 * ship new versions, which is expected — the operator can enter their own list
 * during the add-flow, and that list is what gets stored.
 */

export type AuthScheme = "bearer" | "api_key";

export interface ProviderModel {
  id: string;
  label: string;
}

export interface ProviderPreset {
  /** Stable key used in callback data — must stay short and URL-safe. */
  key: string;
  name: string;
  baseUrl: string;
  authScheme: AuthScheme;
  models: ProviderModel[];
  /** Where the operator obtains a token, shown during the add-flow. */
  tokenHint: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "glm",
    name: "GLM (Z.ai)",
    baseUrl: "https://api.z.ai/api/anthropic",
    authScheme: "bearer",
    models: [
      { id: "glm-4.6", label: "GLM 4.6" },
      { id: "glm-4.5-air", label: "GLM 4.5 Air" },
    ],
    tokenHint: "z.ai → API keys",
  },
  {
    key: "kimi",
    name: "Kimi (Moonshot)",
    baseUrl: "https://api.moonshot.ai/anthropic",
    authScheme: "bearer",
    models: [
      { id: "kimi-k2-0905-preview", label: "Kimi K2" },
      { id: "moonshot-v1-128k", label: "Moonshot v1 128k" },
    ],
    tokenHint: "platform.moonshot.ai → API keys",
  },
  {
    key: "deepseek",
    name: "DeepSeek",
    baseUrl: "https://api.deepseek.com/anthropic",
    authScheme: "bearer",
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner" },
    ],
    tokenHint: "platform.deepseek.com → API keys",
  },
  {
    key: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    authScheme: "bearer",
    models: [
      { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4" },
      { id: "qwen/qwen3-235b-a22b", label: "Qwen3 235B" },
    ],
    tokenHint: "openrouter.ai → Keys",
  },
  {
    key: "custom",
    name: "Custom",
    baseUrl: "",
    authScheme: "bearer",
    models: [],
    tokenHint: "whatever the endpoint expects",
  },
];

export function findPreset(key: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.key === key);
}
