/**
 * How the Ollama proxy is enabled and where it listens.
 *
 * One definition because there are two readers that cannot share a module:
 * `config.ts` validates the whole environment and exits the process when it is
 * invalid, so `cli.ts` — which has to run on a machine with no .env at all, to
 * write one — reads `process.env` directly. Two readers of the same setting is
 * exactly how a flag ends up meaning `"on"` in one file and `"true"` in the
 * other, so both call these.
 */

const TRUTHY = ["1", "true", "yes", "on"];

export const DEFAULT_OLLAMA_PROXY_PORT = 3458;

/** Off unless explicitly turned on. See config.ts for why the default is off. */
export function ollamaProxyEnabled(raw: string | undefined): boolean {
  return TRUTHY.includes((raw ?? "").trim().toLowerCase());
}

/**
 * The listening port.
 *
 * Deliberately not 3456: that is where the claude-code-router attempt of
 * 2026-08-07 listened, and a leftover of it must never be mistaken for this.
 * An unparseable or out-of-range value falls back to the default rather than
 * failing — a `providers` row names a port, and refusing to start over a typo
 * helps nobody.
 */
export function ollamaProxyPort(raw: string | undefined): number {
  const parsed = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return DEFAULT_OLLAMA_PROXY_PORT;
  return parsed;
}

/** Hostnames that only exist inside a container, and what they mean outside one. */
const CONTAINER_ONLY_HOSTS = ["ollama", "host.docker.internal"];

/**
 * `OLLAMA_URL` as a host-side process can actually reach it.
 *
 * `OLLAMA_URL` is written for the bot, which runs in Docker: `.env.example`
 * ships `http://ollama:11434` and docker-compose overrides it to
 * `http://host.docker.internal:11434`. Neither name resolves on the host, and
 * this proxy is host-side by necessity — Claude Code runs in tmux there and
 * Ollama listens on the host's own port.
 *
 * So a correct `.env` for the bot is a broken one for the proxy, and the
 * failure would be a connection error per request rather than anything naming
 * the cause. Container-only names are rewritten to loopback; everything else —
 * including a real remote Ollama — is left exactly as configured.
 */
export function hostReachableOllamaUrl(raw: string | undefined): string {
  const value = (raw ?? "").trim() || "http://localhost:11434";
  try {
    const url = new URL(value);
    if (CONTAINER_ONLY_HOSTS.includes(url.hostname)) {
      url.hostname = "127.0.0.1";
      return url.toString().replace(/\/+$/, "");
    }
    return value.replace(/\/+$/, "");
  } catch {
    // Not a URL at all. Returning it unchanged lets the request fail with the
    // configured value in the message, which is more useful than a guess.
    return value;
  }
}
