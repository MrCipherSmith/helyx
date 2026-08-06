/**
 * One restart at a time.
 *
 * The defect these pin: three restart commands spawned detached work and
 * reported success in about a second, and the only guard was a database check
 * for a row of the same name. Pressing "🔄 Bounce" and then "♻️ Полный рестарт"
 * ran two `tmux kill-session` sequences over one session name, each tearing down
 * what the other had built, both logs reporting success.
 *
 * Driven against a real temporary directory rather than a fake filesystem: the
 * guarantee is that `O_CREAT | O_EXCL` decides the race, and a fixture that
 * answered from memory would be testing the fixture rather than the syscall.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  takeRestartLease,
  releaseRestartLease,
  readRestartLease,
  heldMessage,
  leaseAgeMs,
  LEASE_EXPIRY_MS,
} from "../../utils/restart-lease.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "helyx-lease-"));
  path = join(dir, "restart.lease");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;

describe("taking the lease", () => {
  test("the first taker gets it", () => {
    const result = takeRestartLease("bounce", path, NOW);

    expect(result.ok).toBe(true);
    expect(readRestartLease(path)).toMatchObject({ owner: "bounce", takenAt: NOW });
  });

  test("the second is refused, and told who holds it", () => {
    // The reported case, in miniature: two different commands, one session.
    takeRestartLease("bounce", path, NOW);

    const second = takeRestartLease("full_restart", path, NOW + 3_000);

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("unreachable");
    expect(second.held.owner).toBe("bounce");
    // And the file still belongs to the first: a refusal must not half-take.
    expect(readRestartLease(path)!.owner).toBe("bounce");
  });

  test("of many takers at the same instant, exactly one wins", () => {
    // `O_CREAT | O_EXCL` is what makes this true. A read-then-write would leave
    // a window in which every taker saw an empty path and every taker proceeded.
    const results = Array.from({ length: 20 }, (_, i) =>
      takeRestartLease(`taker-${i}`, path, NOW));

    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  test("a refusal says what to wait for, not only that the answer is no", () => {
    takeRestartLease("full_restart", path, NOW);
    const second = takeRestartLease("bounce", path, NOW + 90_000);
    if (second.ok) throw new Error("expected a refusal");

    expect(heldMessage(second.held, NOW + 90_000)).toBe(
      "restart already running: full_restart, started 1m ago",
    );
  });
});

describe("a lease that outlived its restart", () => {
  test("a stale one is broken, and the break is reported", () => {
    // A restart that died leaves its file behind. A lease nobody can break is a
    // stack nobody can restart — worse than the race it replaced.
    takeRestartLease("host_restart", path, NOW);

    const later = takeRestartLease("bounce", path, NOW + LEASE_EXPIRY_MS + 1);

    expect(later.ok).toBe(true);
    if (!later.ok) throw new Error("unreachable");
    expect(later.broke?.owner).toBe("host_restart");
    expect(readRestartLease(path)!.owner).toBe("bounce");
  });

  test("a live one is not broken, however impatient the next press is", () => {
    // The other half, and the one that matters more: a restart in flight must
    // not have the ground taken from under it one millisecond before expiry.
    takeRestartLease("host_restart", path, NOW);

    const later = takeRestartLease("bounce", path, NOW + LEASE_EXPIRY_MS - 1);

    expect(later.ok).toBe(false);
    expect(readRestartLease(path)!.owner).toBe("host_restart");
  });

  test("two takers breaking the same stale lease do not both win", () => {
    // The race review pushed on, and it is real: `O_EXCL` decides the ordinary
    // case, but on the stale path both takers read the same dead lease, both
    // unlink it, and both create — the second unlink removing the first taker's
    // *fresh* lease. Both would walk away believing they held it, which is the
    // concurrent restart this whole file exists to prevent.
    //
    // The settle is the seam: a competing taker landing inside that window is
    // exactly the interleaving being guarded against, so the test writes one
    // there rather than hoping two threads collide.
    takeRestartLease("host_restart", path, NOW);
    const afterExpiry = NOW + LEASE_EXPIRY_MS + 1;

    const loser = takeRestartLease("bounce", path, afterExpiry, () => {
      // The other taker gets there second and takes the file from under us.
      rmSync(path, { force: true });
      writeFileSync(path, JSON.stringify({ owner: "full_restart", takenAt: afterExpiry, token: "other" }));
    });

    expect(loser.ok).toBe(false);
    if (loser.ok) throw new Error("unreachable");
    expect(loser.held.owner).toBe("full_restart");
    // And the winner keeps it: a loser must not clean up on its way out.
    expect(readRestartLease(path)!.owner).toBe("full_restart");
  });

  test("a takeover that nobody contests still succeeds", () => {
    // The other half of the check above: verification must not turn every
    // takeover into a refusal, or a restart that died would wedge the stack for
    // ever — which is worse than the race.
    takeRestartLease("host_restart", path, NOW);

    const winner = takeRestartLease("bounce", path, NOW + LEASE_EXPIRY_MS + 1, () => {});

    expect(winner.ok).toBe(true);
    expect(readRestartLease(path)!.owner).toBe("bounce");
  });

  test("a corrupt file is not a lease anybody is holding", () => {
    // Half-written by a process killed mid-write. Trusting it would wedge
    // restarts for ever, because it can never expire — it has no timestamp.
    writeFileSync(path, "{not json");

    expect(readRestartLease(path)).toBeNull();
    expect(takeRestartLease("bounce", path, NOW).ok).toBe(true);
  });
});

describe("releasing", () => {
  test("the next take succeeds immediately", () => {
    takeRestartLease("bounce", path, NOW);
    releaseRestartLease(path);

    expect(existsSync(path)).toBe(false);
    expect(takeRestartLease("full_restart", path, NOW + 1).ok).toBe(true);
  });

  test("releasing what was never held is not an error", () => {
    // The detached work releases in a `finally`. A path that never took the
    // lease must not turn a completed restart into a failed one.
    expect(() => releaseRestartLease(path)).not.toThrow();
  });
});

describe("age", () => {
  test("a clock that went backwards does not report a negative age", () => {
    expect(leaseAgeMs({ owner: "bounce", takenAt: NOW + 5_000 }, NOW)).toBe(0);
  });
});
