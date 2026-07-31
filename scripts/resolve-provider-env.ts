#!/usr/bin/env bun
/**
 * Resolve a project's provider/model selection into shell export lines.
 *
 * Called by run-cli.sh as `eval "$(bun scripts/resolve-provider-env.ts "$dir")"`
 * just before launching claude. Prints nothing when the project has no
 * selection, so an unconfigured project launches exactly as it did before.
 *
 * Why a helper instead of psql inline in the shell script:
 *   - the project path reaches SQL as a bound parameter, not string
 *     interpolation into a query;
 *   - the decision logic becomes a pure function this repo can unit-test
 *     (tests/unit/resolve-provider-env.test.ts);
 *   - it reuses the same connection settings as the rest of the bot.
 *
 * The token is written to stdout and consumed by `eval` in the parent shell.
 * It never appears in a command argument, an admin_commands payload, or a log
 * line — do not add debug output that echoes the resolved lines.
 */

export interface ProviderRow {
  baseUrl: string | null;
  authToken: string | null;
  authScheme: string | null;
  model: string | null;
}

/** Single-quote a value for POSIX sh, escaping embedded quotes. */
function q(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Turn a resolved row into shell lines.
 *
 * The security rule this function exists to enforce: when a third-party
 * base_url is in play, ANTHROPIC_API_KEY must be cleared first. helyx's own
 * .env sets it, run-cli.sh loads that with "only if unset" semantics, so a
 * project .env cannot override it — without an explicit unset, the real
 * Anthropic key would be sent to the third-party endpoint.
 *
 * ANTHROPIC_AUTH_TOKEN is cleared for the same reason: a leftover value from
 * a previous provider must not survive into a launch that uses a different
 * auth scheme.
 */
export function resolveProviderEnv(row: ProviderRow): string[] {
  const lines: string[] = [];
  const baseUrl = (row.baseUrl ?? "").trim();
  const token = (row.authToken ?? "").trim();
  const model = (row.model ?? "").trim();

  if (baseUrl) {
    // ★ Security-critical, in this order: clear both auth variables before
    // setting the provider's own. See AC-6.
    lines.push("unset ANTHROPIC_API_KEY");
    lines.push("unset ANTHROPIC_AUTH_TOKEN");
    lines.push(`export ANTHROPIC_BASE_URL=${q(baseUrl)}`);
    if (token) {
      lines.push(
        row.authScheme === "api_key"
          ? `export ANTHROPIC_API_KEY=${q(token)}`
          : `export ANTHROPIC_AUTH_TOKEN=${q(token)}`,
      );
    }
    // Third-party endpoints reject the experimental beta headers Claude Code
    // sends by default, surfacing as opaque 400s.
    lines.push("export CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1");
  }

  // A model with no provider is legitimate: an Anthropic tier switch. That path
  // deliberately leaves the existing auth untouched.
  if (model) lines.push(`export ANTHROPIC_MODEL=${q(model)}`);

  return lines;
}

if (import.meta.main) {
  const projectPath = process.argv[2];
  if (!projectPath) process.exit(0);

  try {
    const { sql } = await import("../memory/db.ts");
    const [row] = await sql`
      SELECT pv.base_url, pv.auth_token, pv.auth_scheme, pr.model
      FROM projects pr
      LEFT JOIN providers pv ON pv.id = pr.provider_id
      WHERE pr.path = ${projectPath}
    `;
    if (row) {
      const lines = resolveProviderEnv({
        baseUrl: row.base_url ?? null,
        authToken: row.auth_token ?? null,
        authScheme: row.auth_scheme ?? null,
        model: row.model ?? null,
      });
      if (lines.length) console.log(lines.join("\n"));
    }
    await sql.end();
  } catch {
    // A database that is unreachable must not stop a session from starting.
    // Printing nothing means the launch proceeds on the default endpoint,
    // which is the pre-existing behaviour.
    process.exit(0);
  }
}
