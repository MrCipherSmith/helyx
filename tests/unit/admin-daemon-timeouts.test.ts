/**
 * Every docker command the admin daemon runs is time-bounded.
 *
 * The queue the daemon serves is single-threaded: it awaits one command before
 * it looks at the next. So an unbounded shell call does not merely fail its own
 * command — it holds every later one behind it, with no bound at all. The one
 * daemon that hangs is dockerd, and the moment an operator reaches for these
 * buttons is the moment it already has.
 *
 * `docker restart` was the only step in the file without a bound, sitting one
 * line above a `docker compose up -d` that had one. Review found it. This is a
 * source scan rather than a behavioural test because the bound lives in a shell
 * string with no seam to drive — and a scan is what catches the *next* docker
 * call added without one, which is the actual risk.
 */

import { describe, test, expect } from "bun:test";

const source = await Bun.file(new URL("../../scripts/admin-daemon.ts", import.meta.url)).text();

/** Every line that hands a docker command to the shell. */
function dockerCalls(): string[] {
  return source
    .split("\n")
    .filter((line) => line.includes("runShell(") && /\bdocker\s/.test(line));
}

describe("the daemon's docker commands", () => {
  test("there are some, so the scan below cannot pass by finding nothing", () => {
    expect(dockerCalls().length).toBeGreaterThan(0);
  });

  test("every one of them is wrapped in a timeout", () => {
    const unbounded = dockerCalls().filter((line) => !/\btimeout \d+\b/.test(line));

    expect(unbounded).toEqual([]);
  });
});
