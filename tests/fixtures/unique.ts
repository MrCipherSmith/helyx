/**
 * A name no other test in this process will use.
 *
 * The supervisor keeps its dedup state in module-level maps keyed by project.
 * A test file's own counter is not enough: `bun test --rerun-each=2`
 * re-evaluates the test file — resetting its counter — while the supervisor
 * module stays cached and remembers every project it has already alerted
 * about. The second pass then found every alert deduped, and 21 tests failed
 * for a reason that had nothing to do with the code under test.
 *
 * The timestamp is what makes it survive that: a counter alone repeats as soon
 * as anything resets it.
 */

let counter = 0;

export function uniqueName(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${++counter}`;
}
