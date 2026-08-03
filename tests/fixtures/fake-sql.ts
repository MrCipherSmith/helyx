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
 * - **A query is lazy, exactly as postgres.js makes it.** Building the tagged
 *   template sends nothing; the query goes out when something calls `.then`,
 *   `.catch` or `.finally` on it. The first version of this fake recorded at
 *   construction, which is a comfortable lie: `utils/skill-handlers.ts` fires a
 *   log insert and never awaits it except through `.catch()`, and with an eager
 *   fake, deleting that `.catch()` would leave the assertions passing while
 *   production stopped sending the query altogether. A fixture that cannot fail
 *   when the code breaks is worse than no fixture.
 *
 * - **`.catch()` on a result nobody awaits has to work**, because that is how
 *   those fire-and-forget queries are written — and it counts as executing
 *   them, which is why they are still recorded.
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

/**
 * A query that has been built but not necessarily sent.
 *
 * postgres.js returns a lazy `Query`; it starts when awaited or when `.then`,
 * `.catch` or `.finally` is called. This mirrors that, because the difference
 * is observable: a fire-and-forget query whose `.catch()` is removed stops
 * being sent, and a fake that ran it anyway would hide the change.
 */
export class FakeQuery implements PromiseLike<unknown[]> {
  private started: Promise<unknown[]> | null = null;

  constructor(private readonly run: () => Promise<unknown[]>) {}

  /** Has anything caused this query to be sent? */
  get executed(): boolean {
    return this.started !== null;
  }

  private exec(): Promise<unknown[]> {
    if (!this.started) this.started = this.run();
    return this.started;
  }

  then<A = unknown[], B = never>(
    onFulfilled?: ((rows: unknown[]) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.exec().then(onFulfilled, onRejected);
  }

  catch<B = never>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<unknown[] | B> {
    return this.exec().catch(onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<unknown[]> {
    return this.exec().finally(onFinally);
  }
}

/**
 * The shape production code sees: a tagged template returning a lazy query,
 * carrying the one postgres.js helper this codebase uses on it.
 *
 * `sql.json` marks a value as JSONB. Production calls it while *building* the
 * template arguments, so a fake without it throws before the query is issued —
 * and the query then never appears in the recording, which reads as "the code
 * did not run that statement". Two test files had already added it by hand.
 */
export type FakeSqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) => FakeQuery) & {
  json: (value: unknown) => unknown;
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
  /**
   * Every query actually sent, in execution order.
   *
   * "Sent" and "written" are different things — a tagged template nothing ever
   * awaits or `.catch()`es is never sent, by postgres.js or by this.
   */
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
  readonly sql: FakeSqlTag = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const raw = strings.reduce((acc, part, i) => acc + part + (i < values.length ? "?" : ""), "");
    const text = normalize(raw);

    // Nothing is recorded yet. The query exists; it has not been sent.
    return new FakeQuery(() => {
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
    });
  }) as FakeSqlTag;

  constructor() {
    // Identity: the value passes through as an ordinary parameter, so a test
    // asserts on what was stored rather than on a wrapper around it.
    this.sql.json = (value: unknown) => value;
  }
}

/** Two matchers are the same if a test would think of them as the same query. */
function sameMatch(a: string | RegExp, b: string | RegExp): boolean {
  if (typeof a === "string" && typeof b === "string") return a === b;
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  return false;
}

