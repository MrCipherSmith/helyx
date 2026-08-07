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
