import { describe, expect, test } from "bun:test";
import { resolveProviderEnv } from "../../scripts/resolve-provider-env.ts";

describe("resolveProviderEnv", () => {
  test("no selection produces no lines — unconfigured projects are untouched", () => {
    expect(resolveProviderEnv({ baseUrl: null, authToken: null, authScheme: null, model: null })).toEqual([]);
    expect(resolveProviderEnv({ baseUrl: "", authToken: "", authScheme: "", model: "" })).toEqual([]);
  });

  test("★ third-party provider clears the Anthropic key before setting its own", () => {
    const lines = resolveProviderEnv({
      baseUrl: "https://api.z.ai/api/anthropic",
      authToken: "secret-token",
      authScheme: "bearer",
      model: "glm-4.6",
    });

    // The unset must be present, and must come before anything that sets auth.
    const unsetKey = lines.indexOf("unset ANTHROPIC_API_KEY");
    expect(unsetKey).toBeGreaterThanOrEqual(0);
    const firstAuthExport = lines.findIndex((l) => l.startsWith("export ANTHROPIC_AUTH_TOKEN=") || l.startsWith("export ANTHROPIC_API_KEY="));
    expect(unsetKey).toBeLessThan(firstAuthExport);

    // A stale token from a previously-selected provider must not survive either.
    expect(lines).toContain("unset ANTHROPIC_AUTH_TOKEN");

    expect(lines).toContain("export ANTHROPIC_BASE_URL='https://api.z.ai/api/anthropic'");
    expect(lines).toContain("export ANTHROPIC_AUTH_TOKEN='secret-token'");
    expect(lines).toContain("export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1");
    expect(lines).toContain("export ANTHROPIC_MODEL='glm-4.6'");
  });

  test("api_key scheme sets ANTHROPIC_API_KEY, still after the unset", () => {
    const lines = resolveProviderEnv({
      baseUrl: "https://example.test/v1",
      authToken: "k-123",
      authScheme: "api_key",
      model: null,
    });
    expect(lines.indexOf("unset ANTHROPIC_API_KEY")).toBeLessThan(lines.indexOf("export ANTHROPIC_API_KEY='k-123'"));
    expect(lines.some((l) => l.startsWith("export ANTHROPIC_AUTH_TOKEN="))).toBe(false);
  });

  test("model without a provider is an Anthropic tier switch — auth left alone", () => {
    const lines = resolveProviderEnv({ baseUrl: null, authToken: null, authScheme: null, model: "claude-opus-4" });
    expect(lines).toEqual(["export ANTHROPIC_MODEL='claude-opus-4'"]);
    expect(lines.some((l) => l.startsWith("unset "))).toBe(false);
  });

  test("values are shell-quoted so a hostile field cannot break out", () => {
    const lines = resolveProviderEnv({
      baseUrl: "https://evil.test/v1",
      authToken: "tok'; rm -rf /; echo '",
      authScheme: "bearer",
      model: "m'; whoami; '",
    });
    // Every emitted value stays inside single quotes; embedded quotes are escaped
    // as '\'' rather than terminating the literal.
    const tokenLine = lines.find((l) => l.startsWith("export ANTHROPIC_AUTH_TOKEN="))!;
    expect(tokenLine).toBe(`export ANTHROPIC_AUTH_TOKEN='tok'\\''; rm -rf /; echo '\\'''`);
    const modelLine = lines.find((l) => l.startsWith("export ANTHROPIC_MODEL="))!;
    expect(modelLine).toBe(`export ANTHROPIC_MODEL='m'\\''; whoami; '\\'''`);
  });

  test("a provider with no token still switches the endpoint without exporting an empty secret", () => {
    const lines = resolveProviderEnv({ baseUrl: "https://example.test", authToken: "", authScheme: "bearer", model: null });
    expect(lines).toContain("export ANTHROPIC_BASE_URL='https://example.test'");
    expect(lines.some((l) => l.includes("AUTH_TOKEN='"))).toBe(false);
    expect(lines).toContain("unset ANTHROPIC_API_KEY");
  });
});
