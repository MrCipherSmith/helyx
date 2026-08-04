/**
 * A shared secret between the hooks on the host and the bot in its container.
 *
 * The bot's HTTP port is reachable from every container on the Docker network,
 * and `isLocalRequest` trusts that whole range — which is fine for endpoints
 * that only read, and not fine for one that sends a message to the operator's
 * chat and then holds a connection open for ten minutes. A peer container
 * should not be able to do either.
 *
 * The secret lives in the one directory both sides already share: `~/.claude`
 * on the host, mounted into the container. Neither side has to be configured,
 * and nothing has to be typed by anyone.
 */

/** File name inside the shared Claude config directory. */
export const HOOK_TOKEN_FILE = "helyx-hook-token";

/**
 * A curl config file carrying the header, written beside the token.
 *
 * The token used to be passed as `-H "x-helyx-hook-token: …"`, which puts it in
 * the process's argument list — visible to every `ps` on the machine, and to
 * anything that reads `/proc`. It was a secret protecting an endpoint that
 * messages the operator's chat, published to every local process for the
 * lifetime of each question.
 *
 * A config file keeps it out of argv. Same directory, same 0600, and curl reads
 * it directly.
 */
export const HOOK_CURL_CONFIG_FILE = "helyx-hook-curl.conf";

/** The contents of that config file for a given token. */
export function curlConfigFor(token: string): string {
  return `header = "x-helyx-hook-token: ${token}"\n`;
}

export interface TokenStore {
  exists: (path: string) => boolean;
  read: (path: string) => string;
  write: (path: string, contents: string) => void;
}

/**
 * The token for this installation, creating it on first use.
 *
 * Returns null when the directory cannot be written — the caller then has no
 * secret to check against, and must decide what that means rather than being
 * handed an empty string that would match an empty header.
 */
export function readOrCreateToken(
  configDir: string,
  store: TokenStore,
  generate: () => string = defaultToken,
): string | null {
  const path = `${configDir}/${HOOK_TOKEN_FILE}`;
  try {
    if (store.exists(path)) {
      const existing = store.read(path).trim();
      // A blank or truncated file is replaced rather than trusted: a token
      // short enough to guess is worse than no token, because it looks like one.
      if (existing.length >= 32) {
        // Written every time rather than only on creation: an installation that
        // predates the config file has a token and no way for the hook to send
        // it, and would silently stop asking questions.
        store.write(`${configDir}/${HOOK_CURL_CONFIG_FILE}`, curlConfigFor(existing));
        return existing;
      }
    }
    const created = generate();
    store.write(path, `${created}\n`);
    store.write(`${configDir}/${HOOK_CURL_CONFIG_FILE}`, curlConfigFor(created));
    return created;
  } catch {
    return null;
  }
}

function defaultToken(): string {
  return crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
}

/**
 * Constant-time comparison.
 *
 * Length is compared first and returns early, which leaks only the length —
 * the token is fixed-width, so that is not a secret.
 */
export function tokenMatches(expected: string | null, presented: unknown): boolean {
  if (!expected) return false;
  if (typeof presented !== "string" || presented.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ presented.charCodeAt(i);
  return diff === 0;
}
