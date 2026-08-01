/**
 * Provider input validation — no DB needed.
 *
 * Every rule here runs before any SQL, so a bad provider is rejected at the
 * Telegram add-flow rather than becoming a row that silently misconfigures a
 * project's launch.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  validateProviderInput,
  parseModelsResponse,
  describeRefreshFailure,
  parseClaudeCredentials,
  fetchProviderModels,
} from "../../services/provider-service.ts";
import { PROVIDER_PRESETS, findPreset } from "../../bot/providers/presets.ts";
import { modelsFor, FALLBACK_DEFAULT_MODELS } from "../../bot/commands/providers.ts";

const ok = { name: "GLM", baseUrl: "https://api.z.ai/api/anthropic", authToken: "t" };

describe("validateProviderInput", () => {
  test("accepts a well-formed provider and returns the normalised values", () => {
    expect(validateProviderInput(ok)).toEqual({ baseUrl: ok.baseUrl, authScheme: "bearer" });
  });

  test("strips trailing slashes — otherwise the launched client builds a double-slash path", () => {
    expect(validateProviderInput({ ...ok, baseUrl: "https://api.z.ai/anthropic///" }).baseUrl)
      .toBe("https://api.z.ai/anthropic");
  });

  test("rejects a non-http scheme, so a file: or javascript: URL never reaches the launcher", () => {
    expect(() => validateProviderInput({ ...ok, baseUrl: "file:///etc/passwd" })).toThrow(/http or https/);
    expect(() => validateProviderInput({ ...ok, baseUrl: "ftp://example.test" })).toThrow(/http or https/);
  });

  test("rejects unparseable URLs", () => {
    expect(() => validateProviderInput({ ...ok, baseUrl: "not a url" })).toThrow(/not a valid URL/);
  });

  test("requires name, base_url and token", () => {
    expect(() => validateProviderInput({ ...ok, name: "  " })).toThrow(/name is required/);
    expect(() => validateProviderInput({ ...ok, baseUrl: "" })).toThrow(/base_url is required/);
    expect(() => validateProviderInput({ ...ok, authToken: "   " })).toThrow(/auth token is required/);
  });

  test("rejects an unknown auth scheme rather than defaulting silently", () => {
    expect(() => validateProviderInput({ ...ok, authScheme: "basic" as never })).toThrow(/auth_scheme must be one of/);
  });

  test("defaults to bearer, and accepts api_key", () => {
    expect(validateProviderInput(ok).authScheme).toBe("bearer");
    expect(validateProviderInput({ ...ok, authScheme: "api_key" }).authScheme).toBe("api_key");
  });
});

describe("provider presets", () => {
  test("every preset except Custom validates as-is once a token is supplied", () => {
    for (const preset of PROVIDER_PRESETS) {
      if (preset.key === "custom") continue;
      expect(() =>
        validateProviderInput({
          name: preset.name,
          baseUrl: preset.baseUrl,
          authToken: "t",
          authScheme: preset.authScheme,
        }),
      ).not.toThrow();
    }
  });

  test("preset keys are unique and short enough for callback data", () => {
    const keys = PROVIDER_PRESETS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(`prov:preset:${key}`.length).toBeLessThanOrEqual(64);
    }
  });

  test("Custom carries no base URL — the add-flow asks for one", () => {
    expect(findPreset("custom")?.baseUrl).toBe("");
  });

  test("findPreset returns undefined for an unknown key instead of throwing", () => {
    expect(findPreset("nope")).toBeUndefined();
  });
});

describe("parseModelsResponse", () => {
  test("reads the {data:[{id}]} shape both Anthropic and OpenAI use", () => {
    expect(parseModelsResponse({ data: [{ id: "glm-5.2" }, { id: "glm-4.6" }] }))
      .toEqual([{ id: "glm-5.2", label: "glm-5.2" }, { id: "glm-4.6", label: "glm-4.6" }]);
  });

  test("prefers display_name as the label when the provider supplies one", () => {
    expect(parseModelsResponse({ data: [{ id: "glm-5.2", display_name: "GLM 5.2" }] }))
      .toEqual([{ id: "glm-5.2", label: "GLM 5.2" }]);
  });

  test("drops entries with no usable id instead of rendering blanks", () => {
    expect(parseModelsResponse({ data: [{ id: "ok" }, { id: "" }, { id: 42 }, {}] }))
      .toEqual([{ id: "ok", label: "ok" }]);
  });

  test("returns null when the payload is not a model list at all", () => {
    // The caller must tell "provider has no models" from "that was an error
    // page", because only the second should fall back to the presets.
    expect(parseModelsResponse({ error: "unauthorized" })).toBeNull();
    expect(parseModelsResponse(null)).toBeNull();
    expect(parseModelsResponse("nope")).toBeNull();
  });

  test("an empty data array is a real answer, not a failure", () => {
    expect(parseModelsResponse({ data: [] })).toEqual([]);
  });
});

describe("modelsFor", () => {
  const provider = {
    id: 1,
    name: "GLM",
    base_url: "https://api.z.ai/api/anthropic",
    auth_scheme: "bearer" as const,
    models: [{ id: "glm-5.2", label: "GLM 5.2" }],
    created_at: new Date(0),
  };

  test("always offers 'Provider default' first, so a project can defer the choice", () => {
    expect(modelsFor(provider)[0]).toEqual({ id: "", label: "Provider default" });
    expect(modelsFor(null, [])[0]).toEqual({ id: "", label: "Provider default" });
  });

  test("renders a registered provider's own stored list", () => {
    expect(modelsFor(provider)).toEqual([
      { id: "", label: "Provider default" },
      { id: "glm-5.2", label: "GLM 5.2" },
    ]);
  });

  test("renders the default's fetched list once it has been refreshed", () => {
    // The point of the refresh button: the hardcoded tiers must not win over
    // what the provider actually reported.
    const fetched = [{ id: "claude-opus-5", label: "Claude Opus 5" }];
    expect(modelsFor(null, fetched)).toEqual([{ id: "", label: "Provider default" }, ...fetched]);
    expect(modelsFor(null, fetched)).not.toContainEqual(FALLBACK_DEFAULT_MODELS[0]);
  });

  test("falls back to hardcoded tiers only for a default that was never refreshed", () => {
    expect(modelsFor(null, [])).toEqual([
      { id: "", label: "Provider default" },
      ...FALLBACK_DEFAULT_MODELS,
    ]);
  });

  test("a registered provider with no models offers only 'Provider default' — never Claude tiers", () => {
    // Offering Anthropic model ids for a GLM endpoint would produce a launch
    // the provider rejects.
    expect(modelsFor({ ...provider, models: [] })).toEqual([{ id: "", label: "Provider default" }]);
  });

  test("selection is by index, so the callback data stays inside Telegram's 64-byte budget", () => {
    const models = modelsFor(null, [{ id: "claude-opus-4-1-20250805-extra-long-id", label: "x" }]);
    models.forEach((_, idx) => {
      expect(`pmsel:9999:model:def:${idx}`.length).toBeLessThanOrEqual(64);
    });
    expect(`pmref:9999:def`.length).toBeLessThanOrEqual(64);
  });
});

describe("describeRefreshFailure", () => {
  test("names the fixable case, so the operator knows to set a key", () => {
    expect(describeRefreshFailure("no_credentials")).toMatch(/ANTHROPIC_API_KEY/);
  });

  test("distinguishes a deleted provider from an unreachable one", () => {
    expect(describeRefreshFailure("unknown_provider")).toMatch(/no longer exists/);
    expect(describeRefreshFailure("unreachable")).toMatch(/did not answer/);
  });
});

describe("parseClaudeCredentials", () => {
  const NOW = 1_700_000_000_000;
  const creds = (over: Record<string, unknown> = {}) => ({
    claudeAiOauth: { accessToken: "tok", expiresAt: NOW + 60_000, ...over },
  });

  test("reads the access token Claude Code stores", () => {
    expect(parseClaudeCredentials(creds(), NOW)).toEqual({ ok: true, token: "tok" });
  });

  test("reports an expired token separately — the operator's fix is to re-run claude", () => {
    expect(parseClaudeCredentials(creds({ expiresAt: NOW - 1 }), NOW))
      .toEqual({ ok: false, reason: "credentials_expired" });
  });

  test("a token expiring this instant is already expired", () => {
    expect(parseClaudeCredentials(creds({ expiresAt: NOW }), NOW).ok).toBe(false);
  });

  test("tries a token with no expiry rather than refusing on an unknown", () => {
    expect(parseClaudeCredentials(creds({ expiresAt: undefined }), NOW)).toEqual({ ok: true, token: "tok" });
    expect(parseClaudeCredentials(creds({ expiresAt: 0 }), NOW)).toEqual({ ok: true, token: "tok" });
    expect(parseClaudeCredentials(creds({ expiresAt: "soon" }), NOW)).toEqual({ ok: true, token: "tok" });
  });

  test("treats a file with no usable token as no credentials, not a crash", () => {
    for (const body of [{}, null, "nope", { claudeAiOauth: {} }, { claudeAiOauth: { accessToken: "" } }]) {
      expect(parseClaudeCredentials(body, NOW)).toEqual({ ok: false, reason: "no_credentials" });
    }
  });
});

describe("fetchProviderModels headers", () => {
  const seen: { url: string; headers: Record<string, string> }[] = [];
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    seen.length = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify({ data: [{ id: "m" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("sends anthropic-version under bearer too — Anthropic answers 400 without it", async () => {
    // A Claude Code session token authenticates as a bearer, so omitting the
    // header here is what made the default endpoint unrefreshable.
    await fetchProviderModels("https://api.anthropic.com", "tok", "bearer");
    expect(seen[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    expect(seen[0]?.headers.authorization).toBe("Bearer tok");
  });

  test("api_key goes in x-api-key, never in authorization", async () => {
    await fetchProviderModels("https://api.anthropic.com", "sk-test", "api_key");
    expect(seen[0]?.headers["x-api-key"]).toBe("sk-test");
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  test("tries /v1/models first and strips a trailing slash from the base url", async () => {
    await fetchProviderModels("https://api.z.ai/api/anthropic/", "tok", "bearer");
    expect(seen[0]?.url).toBe("https://api.z.ai/api/anthropic/v1/models");
  });
});
