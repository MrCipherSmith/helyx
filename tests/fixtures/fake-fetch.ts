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
  /**
   * The body delivered in pieces, one `reader.read()` per entry.
   *
   * `json` and `text` arrive whole, and a whole body is the one shape a
   * streaming reader never has to cope with: every line is complete, every
   * character is complete, and code that mishandles a boundary passes anyway.
   * The two boundary bugs that matter here are both invisible without this —
   * a chunk that ends mid-line, and a chunk that ends mid-UTF-8-sequence, the
   * second of which is impossible to hit in English and mangles the first
   * Cyrillic word that straddles a packet.
   *
   * Strings are encoded whole; split a multi-byte character by passing the
   * bytes yourself. Takes precedence over `json` and `text`.
   */
  chunks?: (string | Uint8Array)[];
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

/**
 * What was actually requested, whichever of `fetch`'s three call shapes was used.
 *
 * `fetch(url, init)`, `fetch(request)` and `fetch(request, init)` are all
 * valid, and only the first puts the method, headers and body in `init`.
 * Building a `Request` resolves all three the same way the platform does.
 */
async function describeRequest(input: unknown, init?: RequestInit): Promise<RecordedRequest> {
  let request: Request;
  try {
    request = new Request(input as RequestInfo, init);
  } catch {
    // A URL the Request constructor rejects still deserves to be recorded —
    // seeing the bad URL is how a test diagnoses what the code built.
    return { method: (init?.method ?? "GET").toUpperCase(), url: urlOf(input), headers: {}, body: null };
  }

  // A clone, so the caller's body stays readable.
  const raw = await request.clone().text().catch(() => "");
  let body: unknown = raw === "" ? null : raw;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      /* not JSON — keep the string */
    }
  }

  return {
    method: request.method.toUpperCase(),
    url: request.url,
    headers: Object.fromEntries(request.headers.entries()),
    body,
  };
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
    // Normalised through Request, because `fetch` accepts three shapes and only
    // one of them puts the method, headers and body in `init`. Reading `init`
    // alone recorded a fully-formed POST Request as a GET with no headers and
    // no body — a test asserting on any of those would have been asserting on
    // the fixture's blind spot.
    const request = await describeRequest(input, init);
    this.requests.push(request);
    const url = request.url;

    // An aborted signal fails before anything is sent, as it does for real.
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

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
    let body: string | ReadableStream<Uint8Array> | null = null;
    if (spec.chunks !== undefined) {
      body = streamOf(spec.chunks);
    } else if (spec.json !== undefined) {
      body = JSON.stringify(spec.json);
      headers["content-type"] ??= "application/json";
    } else if (spec.text !== undefined) {
      body = spec.text;
    }
    return new Response(body, { status: spec.status ?? 200, headers });
  }) as unknown as typeof fetch;
}

/** One enqueue per programmed piece, so each becomes its own `read()`. */
function streamOf(chunks: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const parts = chunks.map((c) => (typeof c === "string" ? encoder.encode(c) : c));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(part);
      controller.close();
    },
  });
}

function hits(match: string | RegExp, url: string): boolean {
  if (typeof match === "string") return url.includes(match);
  // lastIndex is reset first: a `/g` or `/y` regex carries its position between
  // calls, so two identical requests would alternate between matching and
  // missing — a fixture that answers differently depending on how many times it
  // has been asked the same question.
  match.lastIndex = 0;
  return match.test(url);
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
