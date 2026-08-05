/**
 * Which handler a button press reaches.
 *
 * Every interaction the operator has with this bot arrives as a callback, and
 * the dispatch was twenty sequential prefix tests with one load-bearing
 * ordering: `skill:save:` above `skill:`. Get that wrong and a save is handed
 * to the tool launcher — a button that silently does the wrong thing, which is
 * worse than one that errors, because nothing reports it.
 *
 * The file had no test that reached the dispatch at all.
 */

import { describe, test, expect } from "bun:test";
import { routeCallback, CALLBACK_ROUTES, type CallbackRoute } from "../../utils/callback-route.ts";

/** One live example per prefix, as Telegram would deliver it. */
const EXAMPLES: readonly (readonly [data: string, route: CallbackRoute])[] = [
  ["perm:allow:42", "permission"],
  ["ask:a1b2:0:1", "question"],
  ["switch:7", "switch"],
  ["skill:save:deploy", "skill-approval"],
  ["skill:reject:deploy", "skill-approval"],
  ["skill:editname:deploy", "skill-approval"],
  ["cur:approve:12", "curator-approval"],
  ["cur:skip:12", "curator-approval"],
  ["skill:deploy", "tool"],
  ["cmd:review", "tool"],
  ["set_model:opus", "set-model"],
  ["rc:up", "remote-control"],
  ["poll_submit:9", "poll-submit"],
  ["proj:open:3", "project"],
  ["prov:set:openrouter", "provider"],
  ["pmsel:3", "project-model"],
  ["pmchg:3", "project-model"],
  ["pmref:3", "project-model"],
  ["sess:delete:7", "delete-session"],
  ["tmux:restart:helyx", "tmux-action"],
  ["mon:refresh", "monitor"],
  ["sys:health", "system"],
  ["menu:main", "menu"],
  ["sup:ack:4", "supervisor"],
  ["tmuxlog:helyx", "tmux-log"],
  ["now:ask", "now"],
];

describe("routing a callback", () => {
  test("every prefix reaches its own handler", () => {
    // One at a time and named, so a failure says which button broke rather
    // than that some button did.
    for (const [data, expected] of EXAMPLES) {
      expect([data, routeCallback(data)]).toEqual([data, expected]);
    }
  });

  test("a save is not a tool launch", () => {
    // The one ordering that carries weight. `skill:` would swallow all three
    // of these, and the operator's [Save] would open the skill instead.
    expect(routeCallback("skill:save:x")).toBe("skill-approval");
    expect(routeCallback("skill:reject:x")).toBe("skill-approval");
    expect(routeCallback("skill:editname:x")).toBe("skill-approval");
    expect(routeCallback("skill:x")).toBe("tool");
  });

  test("the shadowed prefixes sit above the one that shadows them", () => {
    // Asserted on the table rather than on the outcome, because this is the
    // property a tidy-up could silently lose: the test above would still pass
    // if `skill:` were moved *below* the others by accident, and fail only
    // once someone reordered them the other way. Pin the invariant itself.
    const at = (prefix: string) => CALLBACK_ROUTES.findIndex(([p]) => p === prefix);
    const bare = at("skill:");

    for (const shadowed of ["skill:save:", "skill:reject:", "skill:editname:"]) {
      expect([shadowed, at(shadowed) < bare]).toEqual([shadowed, true]);
    }
  });

  test("an unclaimed callback routes nowhere", () => {
    // Null rather than a wrong guess: a button that quietly does something
    // unexpected is worse than one that says it did not work.
    expect(routeCallback("nonsense:1")).toBeNull();
    expect(routeCallback("")).toBeNull();
    expect(routeCallback(undefined)).toBeNull();
    expect(routeCallback(null)).toBeNull();
  });

  test("a prefix on its own still routes", () => {
    // Telegram callback data is capped at 64 bytes and handlers do get sent
    // the bare prefix; routing must not require a payload.
    expect(routeCallback("menu:")).toBe("menu");
    expect(routeCallback("perm:")).toBe("permission");
  });

  test("the prefix must be at the start", () => {
    // `startsWith`, not `includes`. A payload that happens to contain another
    // prefix must not be stolen by it.
    expect(routeCallback("proj:open:menu:main")).toBe("project");
    expect(routeCallback("xmenu:main")).toBeNull();
  });

  test("no two entries claim the same prefix", () => {
    const prefixes = CALLBACK_ROUTES.map(([p]) => p);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  test("every route in the table has an example here", () => {
    // Keeps this file honest as prefixes are added: a new entry with no
    // example is a button nothing checks.
    const covered = new Set(EXAMPLES.map(([data]) => routeCallback(data)));
    for (const [prefix, route] of CALLBACK_ROUTES) {
      expect([prefix, covered.has(route)]).toEqual([prefix, true]);
    }
    expect(EXAMPLES.length).toBe(CALLBACK_ROUTES.length);
  });
});
