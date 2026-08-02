# One rule in several files diverges, and review does not catch it

Version: 1.0.0
Type: known-mistake
Status: accepted
Confidence: high

## Summary

Seven flows in this repository on 2026-08-02, and the underlying defect was the
same every time: one piece of knowledge written out in several places, then
diverging. Reading the diff does not find it — the copies are outside the diff.
Run `bun run dupes` instead of looking.

## Details

The instances, in order:

| What was duplicated | Copies | Consequence |
|---|---|---|
| ANSI stripping | 5, three of them narrower | the spinner detector read half-stripped text, so a working session was reported as hung |
| the git-ref allowlist | 2 | flow 003 moved one and left the other; found later by the detector, not by three review rounds |
| the permission-dialog rule | restated 4 times, wrong each time | `or` for `and`, any digit for option 1, any distance for a six-line window |
| the edit-guard protocol | 3 | a status update landing during an edit waited for the next 5s tick |
| the pane-parsing rule set | 12 patterns across `output-monitor.ts` and `tmux-monitor.ts` | outstanding |

Two things are worth carrying forward.

**Review does not catch this.** The permission rule went through eight review
rounds across two flows, and a leftover copy in `scripts/tmux-watchdog.ts`
survived all of them — because everyone was reading the diff rather than asking
what remained elsewhere. `bun run dupes` found it in one run.

**A comment claiming two things agree is not a mechanism.** Four separate
attempts to restate the permission rule "the same way `tmux-watchdog.ts` does"
each got it wrong, in code whose comment asserted the agreement. What fixed it
was sharing the predicate so there was nothing left to restate.

The rule that follows: if two places must agree, connect them with an import.
If that is genuinely impossible, the claim needs a test that fails when they
diverge — a comment is not enough.

## Provenance

- Source: manual
- Link: flows 001, 003, 005, 006, 007 in `.metaproject/flows/`
- Created: 2026-08-02
- Updated: 2026-08-02

## Related Scopes

- Module: utils, channel, scripts, mcp
- Entity: terminal parsing, permission prompt detection, status rendering
- Files: utils/terminal.ts, utils/permission-prompt.ts, utils/request-guards.ts, utils/tmux-monitor.ts, utils/output-monitor.ts, scripts/find-duplicate-definitions.ts
- Skills: testing, health

## Tags

duplication, shared-definitions, review-blind-spot, regression

## Changelog

- 1.0.0 - Recorded after seven flows in one day showed the same shape.
