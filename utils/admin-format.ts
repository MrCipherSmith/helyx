/**
 * The numbers the operator reads, and the argument they asked them with.
 *
 * `/permission_stats -5` used to parse to -5, survive `Math.min(-5, 365)` and
 * reach `make_interval(days => -5)` — a window that ends before it begins. The
 * operator was told there were no permission requests in the last -5 days, for
 * a database full of them: wrong, confident and quiet, which is the worst of
 * the three answers available.
 */

/** The window used when none was asked for. */
export const DEFAULT_DAYS = 30;
/** The longest window the query will accept. */
export const MAX_DAYS = 365;
/** How wide a histogram bar is drawn. */
export const BAR_WIDTH = 8;

/**
 * The number of days a stats command was asked for.
 *
 * Anything that is not a positive number becomes the default rather than being
 * handed to the database. `Number("")` is 0 and `Number("x")` is NaN, and both
 * were already caught by a falsy check; a negative number is truthy and was
 * not.
 */
export function parseDaysArg(raw: string | undefined | null): number {
  const value = Number((raw ?? "").trim());
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_DAYS;
  return Math.min(Math.floor(value), MAX_DAYS);
}

/**
 * A share of the total, as the operator sees it.
 *
 * A total of zero returns "0%" rather than dividing: the caller reaches this
 * with whatever the database returned, and an empty table is an ordinary
 * Tuesday rather than an error.
 */
export function percentOf(count: number, total: number): string {
  if (!Number.isFinite(total) || total <= 0) return "0%";
  return `${Math.round((count / total) * 100)}%`;
}

/**
 * A bar proportional to the largest row.
 *
 * Clamped at both ends. Longer than its width it wraps in Telegram and the
 * column stops lining up; shorter than nothing it throws, which `repeat` does
 * for a negative count.
 */
export function histogramBar(value: number, largest: number, width: number = BAR_WIDTH): string {
  const share = largest > 0 ? value / largest : 0;
  const filled = Math.max(0, Math.min(width, Math.round(share * width)));
  return "█".repeat(filled).padEnd(width, "░");
}
