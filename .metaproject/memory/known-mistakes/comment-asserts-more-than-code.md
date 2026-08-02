# A comment that claims agreement is not a mechanism

Version: 1.0.0
Type: known-mistake
Status: accepted
Confidence: high

## Summary

The recurring authoring mistake in this repository is not a logic error: it is
a doc comment asserting more than the code below it does. It is invisible on
re-reading, because the author reads what they meant. Every instance was caught
by an independent reviewer, never by the author.

## Details

Four instances in a single flow (005), each in code whose comment claimed the
opposite:

1. A plan keyed the permission phase on "is there a `● ` tool line", asserting
   that a prompt has none. The real dialog carries one. Caught before writing
   the code, by reading the watchdog's fixture instead of assuming.
2. The comment said the new regexes "detect real prompts". They cannot:
   `utils/tmux-monitor.ts` discards both signal lines before the text reaches
   the classifier. Caught by review — and it was the risk the plan itself
   listed in step 5 and did not run.
3. `isPermissionPrompt` was documented as "the same signals
   `scripts/tmux-watchdog.ts` uses" and combined them with `or`. The watchdog
   requires both.
4. Then, corrected to `and`, it still accepted any digit at any distance; the
   watchdog requires option 1 within six lines.

The same shape in flow 006: `holdAwaitingPermission` was described as bound to
a scope so no exit path could leak, while `sendStatusMessage` still owned the
edit guard itself — two of three paths fixed, reported as three.

## What works

- **Replace the claim with an import.** If a comment says two places agree,
  make them the same code. Four restatements of one rule ended only when the
  predicate moved to `utils/permission-prompt.ts` and both consumers imported
  it.
- **A claim that cannot be an import needs a test that fails when it breaks.**
  Not a comment.
- **Verification steps go in `keryx flow task add`, not in prose.** Instance 2
  above was written down in the plan and skipped; a task would have kept the
  flow open.
- Assume the reviewer will find one. Across seven flows the reviewer found
  something in every single one, and was right nearly every time.

## Provenance

- Source: manual
- Link: flows 005 and 006 in `.metaproject/flows/`
- Created: 2026-08-02
- Updated: 2026-08-02

## Related Scopes

- Module: utils, channel
- Entity: permission prompt detection, status rendering
- Files: utils/status-format.ts, utils/permission-prompt.ts, channel/status.ts, channel/permissions.ts
- Skills: gdskills/orchestration/flow-orchestrator, testing

## Tags

authoring, contracts, review, self-correction

## Changelog

- 1.0.0 - Recorded after the same mistake appeared four times in one flow.
