/**
 * Provider input validation — no DB needed.
 *
 * Every rule here runs before any SQL, so a bad provider is rejected at the
 * Telegram add-flow rather than becoming a row that silently misconfigures a
 * project's launch.
 */

import { describe, expect, test } from "bun:test";
import { validateProviderInput } from "../../services/provider-service.ts";
import { PROVIDER_PRESETS, findPreset } from "../../bot/providers/presets.ts";

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
