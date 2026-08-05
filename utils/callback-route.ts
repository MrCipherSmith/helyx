/**
 * Which handler a button press belongs to.
 *
 * This was twenty sequential `if (data.startsWith(...))` statements, and the
 * order between two of them was load-bearing: `skill:save:` has to be matched
 * before `skill:`, or the save is handed to the tool launcher instead. Nothing
 * in the file said so except a comment, and a comment is not a mechanism — the
 * ordering could be lost to a tidy-up that looked like it changed nothing.
 *
 * As a table it is data: the shadowing is visible, and a test can walk every
 * prefix instead of trusting that twenty branches are in the right sequence.
 */

/** What a callback resolves to. The dispatcher maps these to handlers. */
export type CallbackRoute =
  | "permission"
  | "question"
  | "switch"
  | "skill-approval"
  | "curator-approval"
  | "tool"
  | "set-model"
  | "remote-control"
  | "poll-submit"
  | "project"
  | "provider"
  | "project-model"
  | "delete-session"
  | "tmux-action"
  | "monitor"
  | "system"
  | "menu"
  | "supervisor"
  | "tmux-log"
  | "now";

/**
 * The table, in order. First match wins.
 *
 * The three `skill:…:` entries sit above the bare `skill:` deliberately, and
 * `poll_submit:` above nothing in particular — it shares no prefix with
 * anything. Only the shadowed pairs carry an ordering requirement, and they are
 * the ones a test has to pin.
 */
export const CALLBACK_ROUTES: readonly (readonly [prefix: string, route: CallbackRoute])[] = [
  ["perm:", "permission"],
  ["ask:", "question"],
  ["switch:", "switch"],
  // Shadowed by "skill:" below — these must stay above it.
  ["skill:save:", "skill-approval"],
  ["skill:reject:", "skill-approval"],
  ["skill:editname:", "skill-approval"],
  ["cur:approve:", "curator-approval"],
  ["cur:skip:", "curator-approval"],
  ["skill:", "tool"],
  ["cmd:", "tool"],
  ["set_model:", "set-model"],
  ["rc:", "remote-control"],
  ["poll_submit:", "poll-submit"],
  ["proj:", "project"],
  ["prov:", "provider"],
  ["pmsel:", "project-model"],
  ["pmchg:", "project-model"],
  ["pmref:", "project-model"],
  ["sess:delete:", "delete-session"],
  ["tmux:", "tmux-action"],
  ["mon:", "monitor"],
  ["sys:", "system"],
  ["menu:", "menu"],
  ["sup:", "supervisor"],
  ["tmuxlog:", "tmux-log"],
  ["now:", "now"],
];

/**
 * The handler this callback belongs to, or null if nothing claims it.
 *
 * Null is answered rather than ignored: a button that does nothing at all reads
 * as a broken bot, and the operator presses it again.
 */
export function routeCallback(data: string | undefined | null): CallbackRoute | null {
  if (!data) return null;
  for (const [prefix, route] of CALLBACK_ROUTES) {
    if (data.startsWith(prefix)) return route;
  }
  return null;
}

/**
 * What follows the prefix.
 *
 * The dispatcher used to slice with a hand-written `"set_model:".length`, which
 * is the prefix written twice — once in the table and once in the arithmetic —
 * and only one of the two would be updated when a prefix changed. Derived from
 * the same table that matched it, so they cannot disagree.
 *
 * Empty string when nothing claims the data, which the caller has already
 * refused by then.
 */
export function callbackPayload(data: string | undefined | null): string {
  if (!data) return "";
  for (const [prefix] of CALLBACK_ROUTES) {
    if (data.startsWith(prefix)) return data.slice(prefix.length);
  }
  return "";
}
