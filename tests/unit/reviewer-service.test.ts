/**
 * Reviewer orchestration — pure decision functions.
 *
 * The network and the database are deliberately left out: the mode decision,
 * the provider-URL normalisation and the limit detection are the parts that
 * are wrong when the pipeline misbehaves, and none of them needs a socket or a
 * row to be tested.
 */

import { describe, expect, test } from "bun:test";
import {
  isProviderLimitError,
  normalizeProviderBaseUrl,
  pickMode,
  REVIEW_SYSTEM_PROMPT,
  type ReviewerReport,
} from "../../services/reviewer-service.ts";

function report(ok: boolean): ReviewerReport {
  return { reviewerId: "x", label: "x", model: "m", ok, ...(ok ? { content: "ok" } : { error: "err" }) };
}

describe("normalizeProviderBaseUrl", () => {
  test("strips the Anthropic-compat suffix", () => {
    expect(normalizeProviderBaseUrl("https://api.deepseek.com/anthropic")).toBe("https://api.deepseek.com");
  });

  test("strips a trailing /v1", () => {
    expect(normalizeProviderBaseUrl("https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api");
  });

  test("strips trailing slashes", () => {
    expect(normalizeProviderBaseUrl("https://api.deepseek.com/")).toBe("https://api.deepseek.com");
  });

  test("leaves a bare root alone", () => {
    expect(normalizeProviderBaseUrl("https://api.deepseek.com")).toBe("https://api.deepseek.com");
  });
});

describe("isProviderLimitError", () => {
  test("429 is always a limit error", () => {
    expect(isProviderLimitError(429, "{}")).toBe(true);
  });

  test("insufficient balance is a limit error", () => {
    expect(isProviderLimitError(402, "insufficient balance")).toBe(true);
    expect(isProviderLimitError(400, "your account is suspended due to insufficient balance")).toBe(true);
  });

  test("quota and rate-limit wording is a limit error", () => {
    expect(isProviderLimitError(400, "rate limit exceeded")).toBe(true);
    expect(isProviderLimitError(400, "quota")).toBe(true);
  });

  test("a normal 4xx is not a limit error", () => {
    expect(isProviderLimitError(400, '{"error":{"message":"bad model"}}')).toBe(false);
  });
});

describe("pickMode", () => {
  test("all reviewers down → self", () => {
    expect(pickMode([report(false), report(false)])).toBe("self");
  });

  test("at least one success → external", () => {
    expect(pickMode([report(false), report(true)])).toBe("external");
  });

  test("no reviewers → self", () => {
    expect(pickMode([])).toBe("self");
  });
});

describe("REVIEW_SYSTEM_PROMPT", () => {
  test("is present and model-agnostic", () => {
    expect(REVIEW_SYSTEM_PROMPT.length).toBeGreaterThan(50);
    expect(REVIEW_SYSTEM_PROMPT).toContain("independent code reviewer");
  });
});
