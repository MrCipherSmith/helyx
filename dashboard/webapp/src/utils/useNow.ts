import { useEffect, useState } from "react";

/**
 * Current epoch milliseconds, refreshed on an interval.
 *
 * Reading `Date.now()` during render is impure: the value changes with no
 * corresponding React update, so anything derived from it goes stale until
 * an unrelated re-render happens to refresh it. Holding the clock in state
 * keeps render pure and makes the derived value tick on its own.
 */
export function useNow(intervalMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
