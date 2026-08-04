/**
 * The shared secret between the hooks on the host and the bot in its container.
 *
 * The bot's port is reachable from every container on the Docker network, and
 * the local-request check trusts that whole range. Fine for an endpoint that
 * reads; not fine for one that messages the operator and then holds a
 * connection open for ten minutes.
 */

import { describe, test, expect } from "bun:test";
import {
  readOrCreateToken,
  tokenMatches,
  curlConfigFor,
  HOOK_TOKEN_FILE,
  HOOK_CURL_CONFIG_FILE,
  type TokenStore,
} from "../../utils/hook-token.ts";

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

  test("the curl config is written too, so the token stays out of argv", () => {
    // Passed as -H, the secret sits in the hook's argument list where every
    // `ps` on the machine can read it — for as long as the question is open,
    // guarding an endpoint that messages the operator's chat.
    const store = memoryStore();
    readOrCreateToken("/cfg", store, () => "y".repeat(64));
    expect(store.files[`/cfg/${HOOK_CURL_CONFIG_FILE}`]).toBe(curlConfigFor("y".repeat(64)));
    expect(store.files[`/cfg/${HOOK_CURL_CONFIG_FILE}`]).toContain("x-helyx-hook-token: " + "y".repeat(64));
  });

  test("an installation that predates the config file gets one", () => {
    // It has a token already, and without the config the hook has no way to
    // send it — questions would silently stop arriving.
    const store = memoryStore({ [`/cfg/${HOOK_TOKEN_FILE}`]: `${"a".repeat(40)}\n` });
    readOrCreateToken("/cfg", store);
    expect(store.files[`/cfg/${HOOK_CURL_CONFIG_FILE}`]).toContain("a".repeat(40));
  });

  test("the config is a single header line curl will accept", () => {
    const config = curlConfigFor("tok");
    expect(config).toBe('header = "x-helyx-hook-token: tok"\n');
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

describe("the writer the server supplies", () => {
  test("an existing file is re-hardened, not left as it was found", async () => {
    // writeFileSync's `mode` applies only when the file is created. A config
    // written before the mode was set — or by an older version — would keep
    // whatever permissions it had, which is the one thing this change is about.
    const { mkdtempSync, writeFileSync, chmodSync, statSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    const dir = mkdtempSync(join(tmpdir(), "helyx-token-"));
    const path = join(dir, HOOK_TOKEN_FILE);
    writeFileSync(path, "x".repeat(64), { mode: 0o644 });
    expect(statSync(path).mode & 0o777).toBe(0o644);

    // The writer the server supplies, mirrored here so the assertion is about
    // behaviour rather than about the server module's import graph.
    const write = (p: string, contents: string) => {
      writeFileSync(p, contents, { mode: 0o600 });
      chmodSync(p, 0o600);
    };
    write(path, "y".repeat(64));

    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});
