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

/**
 * Where Claude Code keeps the credentials of the signed-in session.
 *
 * The bot already mounts the operator's `~/.claude` (as HOST_CLAUDE_CONFIG) to
 * read skills, commands and settings, so the file is reachable without any new
 * plumbing. Reading it matters because a subscription login has no API key at
 * all: without this, "Default (Claude)" is the one provider that can never be
 * asked what models it has.
 */
const CLAUDE_CREDENTIALS_FILE = ".credentials.json";

/**
 * `bot_config` key holding the default provider's fetched model list.
 *
 * Registered providers keep their list in `providers.models`; the default has
 * no row to keep it in, and an in-process cache would be gone after every
 * restart — leaving the operator back on the hardcoded tiers until they pressed
 * refresh again.
 */
const DEFAULT_MODELS_KEY = "default_provider_models";

export type RefreshFailure =
  | "no_credentials"
  | "credentials_expired"
  | "unreachable"
  | "unknown_provider";
export type RefreshResult =
  | { ok: true; models: ProviderModel[] }
  | { ok: false; reason: RefreshFailure };

/** Operator-facing explanation of a failed refresh. */
export function describeRefreshFailure(reason: RefreshFailure): string {
  switch (reason) {
    case "no_credentials":
      return "no ANTHROPIC_API_KEY and no signed-in Claude session to borrow";
    case "credentials_expired":
      return "the Claude session token has expired — run claude once to renew it";
    case "unknown_provider":
      return "that provider no longer exists";
    default:
      return "provider did not answer";
  }
}

/** An access token and the scheme to send it under. */
interface Credential {
  token: string;
  scheme: AuthScheme;
}

/**
 * Pull the OAuth access token out of Claude Code's credentials file.
 *
 * Exported without the file read so the shape and expiry handling can be tested
 * without a credentials file on disk — and so no test ever needs a real token.
 *
 * A missing `expiresAt` is treated as "try it": the token may still work, and
 * refusing to send it would turn an unknown into a hard failure.
 */
export function parseClaudeCredentials(
  body: unknown,
  now: number,
): { ok: true; token: string } | { ok: false; reason: "no_credentials" | "credentials_expired" } {
  const oauth = (body as { claudeAiOauth?: unknown })?.claudeAiOauth;
  const token = (oauth as { accessToken?: unknown })?.accessToken;
  if (typeof token !== "string" || !token) return { ok: false, reason: "no_credentials" };
  const expiresAt = (oauth as { expiresAt?: unknown })?.expiresAt;
  if (typeof expiresAt === "number" && expiresAt > 0 && expiresAt <= now) {
    return { ok: false, reason: "credentials_expired" };
  }
  return { ok: true, token };
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
 * Whether a model costs nothing to call.
 *
 * Two signals, because providers say it two ways: OpenRouter suffixes the id of
 * its zero-cost variants with `:free`, and also reports a pricing object whose
 * per-token rates are "0". Either one is enough — a provider that reports
 * neither simply has no free tier as far as this is concerned.
 */
function isFreeModel(entry: unknown, id: string): boolean {
  if (/:free$/i.test(id)) return true;
  const pricing = (entry as { pricing?: unknown })?.pricing as
    | { prompt?: unknown; completion?: unknown }
    | undefined;
  if (!pricing) return false;
  const rate = (v: unknown) => (typeof v === "string" || typeof v === "number" ? Number(v) : NaN);
  const prompt = rate(pricing.prompt);
  const completion = rate(pricing.completion);
  return prompt === 0 && completion === 0;
}

/**
 * Parse a models-list response into our shape, free models first.
 *
 * Anthropic and OpenAI-compatible endpoints both answer with
 * `{ data: [{ id, display_name? }] }`, so one parser covers the field. Exported
 * separately from the fetch so the shape handling can be tested without a
 * network call.
 *
 * The reordering exists because OpenRouter answers with several hundred models
 * in no useful order, and the free ones — the whole reason to try a new
 * provider before paying for it — land wherever they land. Order within each
 * group is left as the provider gave it: that is the provider's own ranking and
 * it is better than anything sorted alphabetically here.
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
      const model: ProviderModel = { id, label: typeof label === "string" && label ? label : id };
      if (isFreeModel(entry, id)) model.free = true;
      return model;
    })
    .filter((m): m is ProviderModel => m !== null);
  return [...models.filter((m) => m.free), ...models.filter((m) => !m.free)];
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
  // anthropic-version goes on every request, not just the api_key one: Anthropic
  // answers 400 without it whatever the scheme, and a bearer token is exactly
  // how a Claude Code session authenticates. OpenAI-compatible endpoints ignore
  // the header, so sending it always costs nothing.
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (authScheme === "api_key") headers["x-api-key"] = authToken;
  else headers.authorization = `Bearer ${authToken}`;

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

/**
 * Credentials to try for the default endpoint, best first.
 *
 * An explicit API key wins because it is a deliberate configuration. The Claude
 * session token is the fallback that makes the subscription case work at all.
 * Returning a list rather than one choice means a stale API key does not block
 * a perfectly good session token.
 *
 * The token is returned, never logged: it grants inference on the operator's
 * account and must go no further than the Anthropic request that needs it.
 */
async function defaultCredentials(
  now: number,
): Promise<{ ok: true; candidates: Credential[] } | { ok: false; reason: RefreshFailure }> {
  const candidates: Credential[] = [];
  if (CONFIG.ANTHROPIC_API_KEY) candidates.push({ token: CONFIG.ANTHROPIC_API_KEY, scheme: "api_key" });

  let parsed: ReturnType<typeof parseClaudeCredentials> | null = null;
  try {
    const raw = await Bun.file(`${CONFIG.HOST_CLAUDE_CONFIG}/${CLAUDE_CREDENTIALS_FILE}`).json();
    parsed = parseClaudeCredentials(raw, now);
  } catch {
    // No file, unreadable, or not JSON — the API key path may still work.
  }
  if (parsed?.ok) candidates.push({ token: parsed.token, scheme: "bearer" });

  if (candidates.length) return { ok: true, candidates };
  // Nothing usable: report the credentials-file verdict when there was one,
  // because "expired" tells the operator to run claude and "missing" does not.
  return { ok: false, reason: parsed && !parsed.ok ? parsed.reason : "no_credentials" };
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
      const creds = await defaultCredentials(Date.now());
      if (!creds.ok) return { ok: false, reason: creds.reason };
      for (const { token, scheme } of creds.candidates) {
        const fetched = await fetchProviderModels(DEFAULT_PROVIDER_BASE_URL, token, scheme);
        if (!fetched?.length) continue;
        await this.setDefaultModels(fetched);
        return { ok: true, models: fetched };
      }
      return { ok: false, reason: "unreachable" };
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
