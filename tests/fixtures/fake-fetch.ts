/**
 * A recording `fetch`, and a guard that makes the network unreachable by
 * default.
 *
 * The guard is the part that matters. `scripts/supervisor.ts` reads
 * `TELEGRAM_BOT_TOKEN` and `SUPERVISOR_CHAT_ID` from the environment at import,
 * `.env` is loaded automatically under `bun test`, and its alert helpers call
 * `fetch` directly. So the first test written against one of its loops — with
 * no precaution taken — posts a message to the real bot, in the real supervisor
 * chat. Not a risk that grows over time: the default outcome, the first time.
 *
 * The same reasoning as the test database in `test-db.ts`. A test that reaches
 * a real service is not a slightly worse test; it is an action taken by
 * something nobody is watching.
 *
 * Two rules follow from that, and both are deliberate:
 *
 * - With no fake installed, every `fetch` throws. Silence is not the safe
 *   default here — a test that quietly reaches an endpoint nobody expected is
 *   exactly what this is for.
 *
 * - With a fake installed, a request matching no programmed pattern also
 *   throws, naming the URL. Returning an empty 200 would let a test pass while
 *   the code under test talked to somewhere the author never considered.
 */

/** One request as it was made. */
export interface RecordedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** The body parsed as JSON when it is JSON, otherwise the raw string. */
  body: unknown;
}

export interface FetchResponse {
  status?: number;
  /** Serialised as JSON with the matching content-type. */
  json?: unknown;
  /** Sent as-is. Ignored when `json` is present. */
  text?: string;
  headers?: Record<string, string>;
}

interface Program {
  match: string | RegExp;
  respond: FetchResponse | ((req: RecordedRequest, nth: number) => FetchResponse);
  hits: number;
}

/** How many requests the guard has refused, across the whole run. */
let blockedCount = 0;

/** Requests the guard refused, for the assertion that the suite stays offline. */
export function blockedRequests(): number {
  return blockedCount;
}

/**
 * Rejects rather than throwing synchronously.
 *
 * `fetch` returns a promise, and code written against it — including the
 * supervisor's `tgPost(...).catch(() => {})` — handles failure through that
 * promise. A guard that threw where the real thing rejects would crash callers
 * that are in fact prepared for a network failure, and would be a different
 * function under test than the one that ships.
 */
async function guard(input: unknown): Promise<never> {
  const url = urlOf(input);
  blockedCount++;
  throw new Error(
    `network blocked in tests: ${url}\n` +
      "Tests do not reach real services. Install a fake with " +
      "`installFakeFetch()` from tests/fixtures/fake-fetch.ts and program the " +
      "responses this code should see.",
  );
}

function urlOf(input: unknown): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

function headersOf(init: RequestInit | undefined): Record<string, string> {
  const raw = init?.headers;
  if (!raw) return {};
  if (raw instanceof Headers) return Object.fromEntries(raw.entries());
  if (Array.isArray(raw)) return Object.fromEntries(raw);
  return { ...(raw as Record<string, string>) };
}

function bodyOf(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") return body ?? null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export class FakeFetch {
  /** Every request made, in order. */
  readonly requests: RecordedRequest[] = [];

  private readonly programs: Program[] = [];

  /**
   * Answer requests whose URL contains `match` (or matches the regex).
   *
   * Programming the same match twice replaces the first, so a shared setup can
   * describe the ordinary case and a test override the one endpoint it is
   * about — the same rule as `FakeSql`, and for the same reason.
   */
  program(match: string | RegExp, respond: Program["respond"] = { json: {} }): this {
    const at = this.programs.findIndex((p) => sameMatch(p.match, match));
    const program: Program = { match, respond, hits: 0 };
    if (at >= 0) this.programs[at] = program;
    else this.programs.push(program);
    return this;
  }

  /** Requests whose URL contains `needle`. */
  matching(needle: string | RegExp): RecordedRequest[] {
    return this.requests.filter((r) => hits(needle, r.url));
  }

  count(needle: string | RegExp): number {
    return this.matching(needle).length;
  }

  /** The last request to a matching URL — usually the one a test means. */
  last(needle: string | RegExp): RecordedRequest | undefined {
    return this.matching(needle).at(-1);
  }

  readonly fetch = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    const url = urlOf(input);
    const request: RecordedRequest = {
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      headers: headersOf(init),
      body: bodyOf(init),
    };
    this.requests.push(request);

    const program = this.programs.find((p) => hits(p.match, url));
    if (!program) {
      throw new Error(
        `no fake response programmed for ${request.method} ${url}\n` +
          "Program it, or leave it unprogrammed deliberately and assert the throw.",
      );
    }

    const nth = program.hits++;
    const spec = typeof program.respond === "function" ? program.respond(request, nth) : program.respond;
    const headers = { ...(spec.headers ?? {}) };
    let body: string | null = null;
    if (spec.json !== undefined) {
      body = JSON.stringify(spec.json);
      headers["content-type"] ??= "application/json";
    } else if (spec.text !== undefined) {
      body = spec.text;
    }
    return new Response(body, { status: spec.status ?? 200, headers });
  }) as unknown as typeof fetch;
}

function hits(match: string | RegExp, url: string): boolean {
  return typeof match === "string" ? url.includes(match) : match.test(url);
}

function sameMatch(a: string | RegExp, b: string | RegExp): boolean {
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  return false;
}

/**
 * Install a recording `fetch` for the duration of a test, and hand back the
 * function that puts the guard back.
 *
 * Restoring puts back the *guard*, not the real `fetch`. Once the run has
 * decided the network is off, a fixture handing the real one back on teardown
 * would reopen it for everything that follows.
 */
export function installFakeFetch(): { http: FakeFetch; restore: () => void } {
  const http = new FakeFetch();
  globalThis.fetch = http.fetch;
  return {
    http,
    restore: () => {
      installNetworkGuard();
    },
  };
}

/** Make every `fetch` throw. Called once by the preload, and by each restore. */
export function installNetworkGuard(): void {
  globalThis.fetch = guard as unknown as typeof fetch;
}
