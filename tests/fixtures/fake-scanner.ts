/**
 * A stubbed external-boundary scanner for tests that exercise code which now
 * scans a crossing (adoption area A1).
 *
 * `utils/external-boundary-scan.ts` reaches keryx through two platform calls:
 * `Bun.which("keryx")` to find the binary and `Bun.spawn(["keryx", …])` to run
 * it. A test that drives, say, `runReviewers` or `synthesize` now runs a scan as
 * a side effect — and its outcome depends on whether keryx happens to be
 * installed on the machine running the test. It is on a developer's laptop and
 * absent on the CI runner, so the same suite passed locally and failed in CI:
 * a missing binary is a "scan unavailable" result, which fails closed and skips
 * the crossing, which is correct in production and wrong as a silent test
 * dependency.
 *
 * This fixture pins the scan to a clean pass so those tests describe the same
 * behaviour on every machine — the same reason `tests/preload.ts` pins the voice
 * chain's credentials. Tests whose subject *is* the boundary use the real keryx
 * (guarded by `Bun.which`) instead; this is for tests whose subject is
 * something else that merely crosses one.
 */

const PASS = '{"gate":"pass","action":"allow","findings":[]}';

/**
 * Make `keryx security check-output` resolve and answer a clean pass, without a
 * real binary. Non-keryx spawns and lookups fall through to the real platform
 * calls. Returns the function that puts both back.
 */
export function installPassingScanner(): { restore: () => void } {
  const realWhich = Bun.which;
  const realSpawn = Bun.spawn;

  (Bun as { which: unknown }).which = ((bin: string, opts?: unknown) =>
    bin === "keryx" ? "/fake/keryx" : (realWhich as (b: string, o?: unknown) => string | null)(bin, opts)) as unknown as typeof Bun.which;

  (Bun as { spawn: unknown }).spawn = ((argv: string[], options?: unknown) => {
    if (Array.isArray(argv) && argv[0] === "keryx") {
      return {
        stdout: new TextEncoder().encode(PASS),
        stderr: new Uint8Array(),
        exited: Promise.resolve(0),
        kill() {},
      };
    }
    return (realSpawn as (a: string[], o?: unknown) => unknown)(argv, options);
  }) as unknown as typeof Bun.spawn;

  return {
    restore: () => {
      (Bun as { which: unknown }).which = realWhich;
      (Bun as { spawn: unknown }).spawn = realSpawn;
    },
  };
}
