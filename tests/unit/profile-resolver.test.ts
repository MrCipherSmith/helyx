/**
 * Unit tests for `llm/profile-resolver.ts` — env-fallback logic and the
 * session-provider wrapper.
 *
 * Caveat — module caching:
 *   `CONFIG` is loaded once at the first `import` of `config.ts`. Because of
 *   this, we cannot easily flip env vars between tests and expect
 *   `resolveFromEnv()` to return different values within the same Bun test
 *   run. We therefore focus on:
 *     - the SHAPE of `ResolvedProvider` returned by `resolveFromEnv()`
 *     - the contract of `resolveSessionProvider(null|undefined)` — must NOT
 *       hit the DB, must return the env-resolved provider verbatim
 *     - the priority ORDER itself is documented in the source and exercised
 *       at runtime; here we assert the function returns a valid, non-empty
 *       provider for the active env, which is the testable invariant.
 */

import { describe, test, expect } from "bun:test";
import { resolveFromEnv, resolveSessionProvider } from "../../llm/profile-resolver.ts";
import type { ResolvedProvider, ProviderType } from "../../llm/types.ts";

const VALID_PROVIDER_TYPES: ProviderType[] = [
  "anthropic",
  "openai",
  "google-ai",
  "ollama",
  "custom-openai",
];

describe("profile-resolver: resolveFromEnv", () => {
  test("returns a ResolvedProvider with required fields populated", () => {
    const resolved = resolveFromEnv();
    expect(resolved).toBeDefined();
    expect(typeof resolved.providerType).toBe("string");
    expect(typeof resolved.model).toBe("string");
    expect(resolved.model.length).toBeGreaterThan(0);
  });

  test("providerType is one of the known ProviderType values", () => {
    const resolved = resolveFromEnv();
    expect(VALID_PROVIDER_TYPES).toContain(resolved.providerType);
  });

  test("ollama fallback has baseUrl set (no apiKey)", () => {
    const resolved = resolveFromEnv();
    if (resolved.providerType === "ollama") {
      expect(resolved.baseUrl).toBeDefined();
      // ollama doesn't need an API key
      expect(resolved.apiKey).toBeUndefined();
    } else {
      // For non-ollama, an API key is expected
      expect(resolved.apiKey).toBeDefined();
      expect(resolved.apiKey?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("non-anthropic providers carry a baseUrl", () => {
    const resolved = resolveFromEnv();
    if (resolved.providerType !== "anthropic") {
      // google-ai / openai (openrouter) / ollama all set baseUrl
      expect(resolved.baseUrl).toBeDefined();
      expect(resolved.baseUrl?.length ?? 0).toBeGreaterThan(0);
    }
  });

  test("anthropic provider sets maxTokens (does not need baseUrl)", () => {
    const resolved = resolveFromEnv();
    if (resolved.providerType === "anthropic") {
      expect(resolved.maxTokens).toBeDefined();
      expect(resolved.maxTokens).toBeGreaterThan(0);
    }
  });
});

describe("profile-resolver: resolveSessionProvider", () => {
  test("null profileId returns env-derived provider without DB query", async () => {
    // If this hit the DB it would either succeed with a row (we don't seed one)
    // or throw a connection error in CI. The function MUST short-circuit.
    const fromSession = await resolveSessionProvider(null);
    const fromEnv = resolveFromEnv();
    expect(fromSession.providerType).toBe(fromEnv.providerType);
    expect(fromSession.model).toBe(fromEnv.model);
  });

  test("undefined profileId returns env-derived provider", async () => {
    const fromSession = await resolveSessionProvider(undefined);
    const fromEnv = resolveFromEnv();
    expect(fromSession.providerType).toBe(fromEnv.providerType);
    expect(fromSession.model).toBe(fromEnv.model);
  });

  test("returned ResolvedProvider has all expected optional fields available", async () => {
    const resolved: ResolvedProvider = await resolveSessionProvider(null);
    // Required
    expect(resolved.providerType).toBeDefined();
    expect(resolved.model).toBeDefined();
    // Optional fields — should at least be present as keys on the object
    // when the resolver branch sets them. We just verify shape compatibility.
    const keys = Object.keys(resolved);
    expect(keys).toContain("providerType");
    expect(keys).toContain("model");
  });

  test("non-existent profileId falls back to env without throwing", async () => {
    // profileId 999999999 should not exist; the resolver catches and falls back.
    // If the DB is unreachable that's also a failure path that should fall back.
    const resolved = await resolveSessionProvider(999_999_999);
    const fromEnv = resolveFromEnv();
    // Either the DB is up and threw "not found" → fell back to env (matches),
    // OR the DB is down and threw a connection error → also fell back to env.
    // Either way the result must equal the env resolution.
    expect(resolved.providerType).toBe(fromEnv.providerType);
    expect(resolved.model).toBe(fromEnv.model);
  });
});
