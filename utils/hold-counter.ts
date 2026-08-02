/**
 * A counted hold, keyed by string.
 *
 * A flag would be enough if only one thing could ever hold a key at a time.
 * For the permission-waiting signal that is not true: two prompts can be
 * pending in the same chat, and with a flag the first to finish would clear
 * the signal while the second was still blocked — the operator would watch 💬
 * disappear and conclude the session had been unblocked.
 *
 * Releasing more times than acquired is not an error and does not go
 * negative. Callers pair acquire with release in a `finally`, and a stray
 * extra release should not be able to make a later hold start from below
 * zero and read as free while it is held.
 */
export class HoldCounter {
  private counts = new Map<string, number>();

  acquire(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  release(key: string): void {
    const held = this.counts.get(key) ?? 0;
    if (held <= 1) this.counts.delete(key);
    else this.counts.set(key, held - 1);
  }

  isHeld(key: string): boolean {
    return (this.counts.get(key) ?? 0) > 0;
  }

  /** How many holders, for assertions and diagnostics. */
  depth(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}
