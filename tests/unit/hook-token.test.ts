/**
 * The shared secret between the hooks on the host and the bot in its container.
 *
 * The bot's port is reachable from every container on the Docker network, and
 * the local-request check trusts that whole range. Fine for an endpoint that
 * reads; not fine for one that messages the operator and then holds a
 * connection open for ten minutes.
 */

import { describe, test, expect } from "bun:test";
import { readOrCreateToken, tokenMatches, HOOK_TOKEN_FILE, type TokenStore } from "../../utils/hook-token.ts";

function memoryStore(initial: Record<string, string> = {}): TokenStore & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    exists: (path) => path in files,
    read: (path) => files[path]!,
    write: (path, contents) => { files[path] = contents; },
  };
}

describe("readOrCreateToken", () => {
  test("creates one on first use and writes it where both sides look", () => {
    const store = memoryStore();
    const token = readOrCreateToken("/cfg", store, () => "x".repeat(64));
    expect(token).toBe("x".repeat(64));
    expect(store.files[`/cfg/${HOOK_TOKEN_FILE}`]).toBe("x".repeat(64) + "\n");
  });

  test("reuses the existing one, trailing newline and all", () => {
    const store = memoryStore({ [`/cfg/${HOOK_TOKEN_FILE}`]: `${"a".repeat(40)}\n` });
    expect(readOrCreateToken("/cfg", store, () => "new")).toBe("a".repeat(40));
  });

  test("a short or blank file is replaced, not trusted", () => {
    // A token short enough to guess is worse than none, because it looks like
    // protection.
    for (const existing of ["", "\n", "short"]) {
      const store = memoryStore({ [`/cfg/${HOOK_TOKEN_FILE}`]: existing });
      expect(readOrCreateToken("/cfg", store, () => "y".repeat(64))).toBe("y".repeat(64));
    }
  });

  test("an unwritable directory yields null rather than an empty string", () => {
    // An empty string would compare equal to a missing header.
    const store: TokenStore = {
      exists: () => false,
      read: () => "",
      write: () => { throw new Error("read-only"); },
    };
    expect(readOrCreateToken("/cfg", store)).toBeNull();
  });

  test("the generated token is long and differs between installations", () => {
    const a = readOrCreateToken("/cfg", memoryStore());
    const b = readOrCreateToken("/cfg", memoryStore());
    expect(a!.length).toBeGreaterThanOrEqual(32);
    expect(a).not.toBe(b);
  });
});

describe("tokenMatches", () => {
  test("matches the exact token and nothing else", () => {
    expect(tokenMatches("secret-value-secret-value-secret", "secret-value-secret-value-secret")).toBe(true);
    expect(tokenMatches("secret-value-secret-value-secret", "secret-value-secret-value-secreT")).toBe(false);
  });

  test("no configured token means nothing is accepted", () => {
    // Not even a request that sends nothing, which is the shape a mistake takes.
    expect(tokenMatches(null, "anything")).toBe(false);
    expect(tokenMatches(null, undefined)).toBe(false);
    expect(tokenMatches("", "")).toBe(false);
  });

  test("a header that is not a string is not a token", () => {
    // Node hands back an array when a header is repeated.
    expect(tokenMatches("abc", ["abc"])).toBe(false);
    expect(tokenMatches("abc", undefined)).toBe(false);
  });
});
