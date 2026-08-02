import { useEffect, useState } from "react";

/**
 * Current epoch milliseconds, refreshed on an interval.
 *
 * Reading `Date.now()` during render is impure: the value changes without
 * anything telling React to re-render, so a "3m ago" label silently rots
 * until some unrelated state update happens to repaint it. Holding the
 * clock in state makes render pure and makes the label update on its own.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return now;
}
