/**
 * A counted hold, keyed by string.
 *
 * A flag would be enough if only one thing could ever hold a key at a time.
 * For the permission-waiting signal that is not true: two prompts can be
 * pending in the same chat, and with a flag the first to finish would clear
 * the signal while the second was still blocked — the operator would watch 💬
 * disappear and conclude the session had been unblocked.
 *
 * `acquire` hands back the function that releases that hold and nothing else.
 * Calling it twice does nothing, so a stray release cannot consume a different
 * holder's hold — which a keyed `release(key)` cannot prevent, having no way
 * to tell whose hold it is releasing.
 */
export class HoldCounter {
  private counts = new Map<string, number>();

  /**
   * Take a hold, and return the one function that releases it.
   *
   * A lease rather than a bare `release(key)` because releases need identity.
   * With a keyed release, one holder calling it twice consumes another
   * holder's hold — the second prompt in a chat would find its signal already
   * taken down. Calling a lease twice is a no-op.
   */
  acquire(key: string): () => void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const held = this.counts.get(key) ?? 0;
      if (held <= 1) this.counts.delete(key);
      else this.counts.set(key, held - 1);
    };
  }

  isHeld(key: string): boolean {
    return (this.counts.get(key) ?? 0) > 0;
  }

  /** How many holders, for assertions and diagnostics. */
  depth(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}
