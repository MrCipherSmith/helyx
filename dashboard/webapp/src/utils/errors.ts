/**
 * Message from an unknown thrown value.
 *
 * `catch (e)` gives `unknown`, and reaching for `e.message` behind an `any`
 * lies about that: a rejected fetch can throw a string, a DOMException, or
 * anything else. This narrows once, so the display path never crashes on a
 * non-Error throw.
 */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
