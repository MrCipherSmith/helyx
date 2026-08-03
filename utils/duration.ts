/**
 * The duration argument the CLIs accept: `30m`, `2h`, `1d`.
 *
 * Two commands took this format and each wrote out both the pattern and the
 * conversion, so the units lived in two places and agreed by coincidence.
 *
 * The result is milliseconds rather than the match, because converting was the
 * duplicated part: extracting only the pattern would have left `60_000`,
 * `3_600_000` and `86_400_000` written twice, which is the same defect one
 * layer down.
 */

const DURATION_RE = /^(\d+)(m|h|d)$/;

const UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/**
 * Milliseconds for a duration string, or `null` if it is not one.
 *
 * Null rather than a default, because the two callers disagree about what to
 * do with a bad value and both are right: one command falls back to an hour,
 * the other refuses and exits with a usage message. That is a decision for the
 * caller, and folding it in here would have silently changed one of them.
 */
export function parseDuration(value: string): number | null {
  const match = value.match(DURATION_RE);
  if (!match) return null;
  return parseInt(match[1]!, 10) * UNIT_MS[match[2]!]!;
}
