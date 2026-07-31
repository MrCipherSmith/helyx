import { sql } from "../memory/db.ts";
import type { AuthScheme, ProviderModel } from "../bot/providers/presets.ts";

/**
 * Registered Anthropic-compatible provider.
 *
 * `auth_token` is a secret. It is read here and passed to the launcher through
 * the host process environment; it must never reach an admin_commands payload,
 * a tmux command argument, or a log line.
 */
export interface Provider {
  id: number;
  name: string;
  base_url: string;
  auth_token: string;
  auth_scheme: AuthScheme;
  models: ProviderModel[];
  created_at: Date;
}

/** Provider without the secret — safe to log or render. */
export type ProviderSummary = Omit<Provider, "auth_token">;

export interface CreateProviderInput {
  name: string;
  baseUrl: string;
  authToken: string;
  authScheme?: AuthScheme;
  models?: ProviderModel[];
}

const AUTH_SCHEMES: AuthScheme[] = ["bearer", "api_key"];

/**
 * How "default Anthropic" is represented.
 *
 * Chosen: `projects.provider_id IS NULL`, with no sentinel row in `providers`.
 *
 * The alternative — a sentinel row so the picker is uniform — was rejected
 * because it puts a row with an empty base_url and an empty token into a table
 * whose every other row is a real endpoint with a real secret. Every consumer
 * would then need to special-case that row anyway, and a stray DELETE would
 * silently change what "default" means. NULL cannot be deleted, needs no
 * migration to create, and makes the fallback obvious at the SQL level.
 *
 * The cost is that the Telegram picker has to prepend a synthetic
 * "Default (Claude)" entry, which it does in exactly one place.
 */
export const DEFAULT_PROVIDER_LABEL = "Default (Claude)";

function validate(input: CreateProviderInput): { baseUrl: string; authScheme: AuthScheme } {
  const name = input.name.trim();
  if (!name) throw new Error("provider name is required");

  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("base_url is required");
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`base_url is not a valid URL: ${baseUrl}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`base_url must be http or https, got ${parsed.protocol}`);
  }

  if (!input.authToken.trim()) throw new Error("auth token is required");

  const authScheme = input.authScheme ?? "bearer";
  if (!AUTH_SCHEMES.includes(authScheme)) {
    throw new Error(`auth_scheme must be one of ${AUTH_SCHEMES.join(", ")}, got ${authScheme}`);
  }

  return { baseUrl, authScheme };
}

export class ProviderService {
  /** Providers without their tokens — use for anything user-facing. */
  async list(): Promise<ProviderSummary[]> {
    return sql`
      SELECT id, name, base_url, auth_scheme, models, created_at
      FROM providers
      ORDER BY name
    ` as unknown as ProviderSummary[];
  }

  /** Full row including the secret. Only the launcher path should need this. */
  async get(id: number): Promise<Provider | null> {
    const [row] = await sql`
      SELECT id, name, base_url, auth_token, auth_scheme, models, created_at
      FROM providers WHERE id = ${id}
    `;
    return (row as Provider) ?? null;
  }

  async getByName(name: string): Promise<ProviderSummary | null> {
    const [row] = await sql`
      SELECT id, name, base_url, auth_scheme, models, created_at
      FROM providers WHERE name = ${name.trim()}
    `;
    return (row as ProviderSummary) ?? null;
  }

  async create(input: CreateProviderInput): Promise<ProviderSummary> {
    const { baseUrl, authScheme } = validate(input);
    const [row] = await sql`
      INSERT INTO providers (name, base_url, auth_token, auth_scheme, models)
      VALUES (
        ${input.name.trim()}, ${baseUrl}, ${input.authToken.trim()},
        ${authScheme}, ${sql.json((input.models ?? []) as unknown as Record<string, never>[])}
      )
      RETURNING id, name, base_url, auth_scheme, models, created_at
    `;
    return row as ProviderSummary;
  }

  /**
   * Remove a provider. Projects using it fall back to the default Anthropic
   * endpoint via ON DELETE SET NULL — they are not deleted and do not break,
   * but they will come back on Claude at their next restart. The caller is
   * responsible for telling the operator which projects were affected.
   */
  async remove(id: number): Promise<{ removed: boolean; affectedProjects: string[] }> {
    const affected = await sql`
      SELECT name FROM projects WHERE provider_id = ${id} ORDER BY name
    `;
    const result = await sql`DELETE FROM providers WHERE id = ${id} RETURNING id`;
    return {
      removed: result.length > 0,
      affectedProjects: (affected as unknown as { name: string }[]).map((r) => r.name),
    };
  }
}

export const providerService = new ProviderService();
