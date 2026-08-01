import { sql } from "../memory/db.ts";
import { CONFIG } from "../config.ts";
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

/**
 * Where the default provider answers its model list.
 *
 * The default has no `providers` row (see above), so its endpoint and scheme
 * cannot be read from the database the way a registered provider's are. They
 * are the Anthropic ones by definition — that is what "default" means here.
 */
const DEFAULT_PROVIDER_BASE_URL = "https://api.anthropic.com";
const DEFAULT_PROVIDER_AUTH_SCHEME: AuthScheme = "api_key";

/**
 * `bot_config` key holding the default provider's fetched model list.
 *
 * Registered providers keep their list in `providers.models`; the default has
 * no row to keep it in, and an in-process cache would be gone after every
 * restart — leaving the operator back on the hardcoded tiers until they pressed
 * refresh again.
 */
const DEFAULT_MODELS_KEY = "default_provider_models";

export type RefreshFailure = "no_credentials" | "unreachable" | "unknown_provider";
export type RefreshResult =
  | { ok: true; models: ProviderModel[] }
  | { ok: false; reason: RefreshFailure };

/** Operator-facing explanation of a failed refresh. */
export function describeRefreshFailure(reason: RefreshFailure): string {
  switch (reason) {
    case "no_credentials":
      return "no ANTHROPIC_API_KEY set — cannot ask Claude for its list";
    case "unknown_provider":
      return "that provider no longer exists";
    default:
      return "provider did not answer";
  }
}

/**
 * Validate and normalise provider input. Exported so the rules can be tested
 * without a database — every rejection here happens before any SQL runs.
 *
 * Normalisation matters as much as rejection: a trailing slash on base_url
 * would produce a double slash once Claude Code appends its path.
 */
export function validateProviderInput(input: CreateProviderInput): { baseUrl: string; authScheme: AuthScheme } {
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

/**
 * Parse a models-list response into our shape.
 *
 * Anthropic and OpenAI-compatible endpoints both answer with
 * `{ data: [{ id, display_name? }] }`, so one parser covers the field. Exported
 * separately from the fetch so the shape handling can be tested without a
 * network call.
 *
 * Returns null rather than an empty array when the payload is not a model list
 * at all — the caller needs to tell "provider says it has no models" apart from
 * "that response was something else entirely".
 */
export function parseModelsResponse(body: unknown): ProviderModel[] | null {
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) return null;
  const models = data
    .map((entry) => {
      const id = (entry as { id?: unknown })?.id;
      if (typeof id !== "string" || !id) return null;
      const label = (entry as { display_name?: unknown })?.display_name;
      return { id, label: typeof label === "string" && label ? label : id };
    })
    .filter((m): m is ProviderModel => m !== null);
  return models;
}

/**
 * Ask the provider what models it has.
 *
 * Hardcoded model lists go stale the moment a vendor ships a new version — the
 * GLM preset shipped naming 4.6 while z.ai had already moved to 5.2. Asking is
 * the only way to stay current.
 *
 * Tries the Anthropic path first, then the OpenAI-compatible one, because a
 * base URL ending in `/anthropic` usually still answers OpenAI-style routes on
 * a sibling path. Returns null if nothing answers — the caller falls back to
 * the preset suggestions rather than leaving the operator with no list.
 */
export async function fetchProviderModels(
  baseUrl: string,
  authToken: string,
  authScheme: AuthScheme,
): Promise<ProviderModel[] | null> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (authScheme === "api_key") {
    headers["x-api-key"] = authToken;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers.authorization = `Bearer ${authToken}`;
  }

  const root = baseUrl.replace(/\/+$/, "");
  const candidates = [`${root}/v1/models`, `${root}/models`];

  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const parsed = parseModelsResponse(await res.json());
      if (parsed?.length) return parsed;
    } catch {
      // Unreachable, timed out, or not JSON — try the next candidate.
    }
  }
  return null;
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
    const { baseUrl, authScheme } = validateProviderInput(input);
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
  /** Replace a provider's stored model list. */
  async updateModels(id: number, models: ProviderModel[]): Promise<ProviderSummary | null> {
    const [row] = await sql`
      UPDATE providers
      SET models = ${sql.json(models as unknown as Record<string, never>[])}
      WHERE id = ${id}
      RETURNING id, name, base_url, auth_scheme, models, created_at
    `;
    return (row as ProviderSummary) ?? null;
  }

  /** The default provider's last fetched model list, or [] if never fetched. */
  async getDefaultModels(): Promise<ProviderModel[]> {
    const rows = await sql`SELECT value FROM bot_config WHERE key = ${DEFAULT_MODELS_KEY}`;
    const raw = (rows as unknown as { value: string }[])[0]?.value;
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as ProviderModel[]) : [];
    } catch {
      // A corrupt cache is not worth failing the picker over — refetching fixes it.
      return [];
    }
  }

  async setDefaultModels(models: ProviderModel[]): Promise<void> {
    await sql`
      INSERT INTO bot_config (key, value) VALUES (${DEFAULT_MODELS_KEY}, ${JSON.stringify(models)})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
    `;
  }

  /**
   * Ask a provider for its current models and store the answer.
   *
   * `providerId === null` means the default endpoint, refreshed the same way as
   * any other — the only difference is where the credentials and the result
   * live. A failure never clears what was stored before: a provider that is
   * briefly unreachable must not cost the operator a working list.
   *
   * The failure reason is reported rather than folded into null because the two
   * cases need different answers. "No credentials" is a configuration the
   * operator can fix (set ANTHROPIC_API_KEY); "unreachable" is worth retrying.
   */
  async refreshModels(providerId: number | null): Promise<RefreshResult> {
    if (providerId === null) {
      const token = CONFIG.ANTHROPIC_API_KEY;
      if (!token) return { ok: false, reason: "no_credentials" };
      const fetched = await fetchProviderModels(
        DEFAULT_PROVIDER_BASE_URL,
        token,
        DEFAULT_PROVIDER_AUTH_SCHEME,
      );
      if (!fetched?.length) return { ok: false, reason: "unreachable" };
      await this.setDefaultModels(fetched);
      return { ok: true, models: fetched };
    }

    const provider = await this.get(providerId);
    if (!provider) return { ok: false, reason: "unknown_provider" };
    const fetched = await fetchProviderModels(
      provider.base_url,
      provider.auth_token,
      provider.auth_scheme,
    );
    if (!fetched?.length) return { ok: false, reason: "unreachable" };
    await this.updateModels(providerId, fetched);
    return { ok: true, models: fetched };
  }

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
