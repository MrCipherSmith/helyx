/**
 * A fake `sql` — a recording tagged template that stands in for postgres.js.
 *
 * Written because two test files had already grown their own. The one in
 * `skill-handlers.test.ts` matched on query text and returned programmed rows;
 * the shape was right, and the only thing wrong with it was that the next test
 * file to need one would have written a third.
 *
 * Three decisions in here are not obvious, and each of them came from a real
 * caller rather than from taste:
 *
 * - **An unmatched query resolves to `[]`, it does not throw.** Production code
 *   reads `rows.length` on paths a given test is not exercising. A fake that
 *   threw on the first unprogrammed query would fail tests for the wrong
 *   reason, and the failure would point at the fixture instead of the code.
 *
 * - **Recording happens when the query is issued, not when it resolves.**
 *   `channel/permissions.ts` has three updates written as
 *   ``sql`UPDATE …`.catch(() => {})`` — fired and never awaited. A fake that
 *   recorded on resolution would drop exactly the queries hardest to observe
 *   any other way.
 *
 * - **The result is a real Promise.** `.catch()` on it has to work, because
 *   that is how those three are written.
 */

/** One query as it was issued. */
export interface RecordedQuery {
  /** Whitespace-collapsed text with each parameter replaced by `?`. */
  text: string;
  /** The text as written, newlines and indentation intact. */
  raw: string;
  /** Interpolated values, in order. */
  values: unknown[];
}

/** What a programmed match should produce. */
export interface QueryResponse {
  /** Rows to resolve with, or a function of the values and how many times this program has matched before. */
  rows?: unknown[] | ((values: unknown[], nth: number) => unknown[]);
  /** Reject with this instead. A function is called per match, for the same reason `rows` may be one. */
  error?: Error | ((values: unknown[], nth: number) => Error);
}

interface Program extends QueryResponse {
  match: string | RegExp;
  hits: number;
}

/** The marker `sql(value)` returns — postgres.js's fragment/identifier form. */
export interface SqlFragment {
  readonly __fragment: unknown;
}

export function isSqlFragment(value: unknown): value is SqlFragment {
  return typeof value === "object" && value !== null && "__fragment" in value;
}

/** The callable shape production code sees: a tagged template that is also a function. */
export type FakeSqlTag = {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
  (value: unknown): SqlFragment;
};

function normalize(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * A fake database connection.
 *
 * ```ts
 * const db = new FakeSql();
 * db.program("SELECT chat_id FROM chat_sessions", { rows: [{ chat_id: "42" }] });
 * await handler.handle(params);
 * expect(db.matching("INSERT INTO permission_requests")).toHaveLength(1);
 * ```
 */
export class FakeSql {
  /** Every query issued, in order, including ones nobody awaited. */
  readonly queries: RecordedQuery[] = [];

  private readonly programs: Program[] = [];

  /**
   * Program a response for queries whose normalized text contains `match`, or
   * matches it if it is a regex.
   *
   * Programs are tried in registration order and the first match wins, so a
   * narrow program registered before a broad one shadows it. That ordering is
   * deliberate: it lets a test say "this specific query behaves differently"
   * without having to describe everything else.
   *
   * Programming the *same* match twice replaces the first rather than being
   * shadowed by it. That is what makes a shared setup helper usable: the helper
   * describes the ordinary case and the test overrides the one query it is
   * about. Without this the override is silently ignored and the test passes or
   * fails on the helper's answer — which is how the first two tests written
   * against this fixture failed, and they were right to.
   */
  program(match: string | RegExp, response: QueryResponse = {}): this {
    const replacing = this.programs.findIndex((p) => sameMatch(p.match, match));
    const program: Program = { match, hits: 0, ...response };
    if (replacing >= 0) this.programs[replacing] = program;
    else this.programs.push(program);
    return this;
  }

  /**
   * Program a sequence of responses for the same query — the nth match gets the
   * nth entry, and the last entry repeats once the list runs out.
   *
   * Poll loops need this: `pollForResponse` issues the same SELECT until it
   * comes back non-empty, so "empty, empty, then the answer" is the shape of
   * almost every test of it.
   */
  programSequence(match: string | RegExp, responses: QueryResponse[]): this {
    if (responses.length === 0) throw new Error("programSequence needs at least one response");
    const pick = (nth: number) => responses[Math.min(nth, responses.length - 1)]!;
    return this.program(match, {
      rows: (values, nth) => {
        const step = pick(nth);
        if (step.error) throw typeof step.error === "function" ? step.error(values, nth) : step.error;
        const rows = step.rows ?? [];
        return typeof rows === "function" ? rows(values, nth) : rows;
      },
    });
  }

  /** Queries whose normalized text contains `needle` (or matches the regex). */
  matching(needle: string | RegExp): RecordedQuery[] {
    return this.queries.filter((q) => this.hits(needle, q.text));
  }

  /** How many queries matched. */
  count(needle: string | RegExp): number {
    return this.matching(needle).length;
  }

  /** Forget everything recorded, keeping the programs. */
  clear(): void {
    this.queries.length = 0;
  }

  private hits(match: string | RegExp, text: string): boolean {
    return typeof match === "string" ? text.includes(match) : match.test(text);
  }

  /**
   * The value to hand to production code as its `sql`.
   *
   * Bound rather than a method so it can be passed around detached, which is
   * how every caller uses it — `{ sql: db.sql }`.
   */
  readonly sql: FakeSqlTag = ((first: TemplateStringsArray | unknown, ...values: unknown[]) => {
    // postgres.js's `sql` is overloaded: tagged-template for queries, plain call
    // for fragments and identifier lists (`... IN ${sql(ids)}`). A template
    // literal always arrives with a frozen `raw` array, which nothing else has.
    if (!isTemplateStrings(first)) {
      return { __fragment: first } satisfies SqlFragment;
    }

    const raw = first.reduce((acc, part, i) => acc + part + (i < values.length ? "?" : ""), "");
    const text = normalize(raw);
    this.queries.push({ text, raw, values });

    const program = this.programs.find((p) => this.hits(p.match, text));
    if (!program) return Promise.resolve([]);

    const nth = program.hits++;
    if (program.error) {
      const err = typeof program.error === "function" ? program.error(values, nth) : program.error;
      return Promise.reject(err);
    }
    try {
      const rows = program.rows ?? [];
      return Promise.resolve(typeof rows === "function" ? rows(values, nth) : rows);
    } catch (err) {
      // A `rows` function may throw to signal a query failure — programSequence
      // uses that to place an error at one step of a sequence.
      return Promise.reject(err);
    }
  }) as FakeSqlTag;
}

/** Two matchers are the same if a test would think of them as the same query. */
function sameMatch(a: string | RegExp, b: string | RegExp): boolean {
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  return false;
}

function isTemplateStrings(value: unknown): value is TemplateStringsArray {
  return Array.isArray(value) && Array.isArray((value as unknown as TemplateStringsArray).raw);
}
