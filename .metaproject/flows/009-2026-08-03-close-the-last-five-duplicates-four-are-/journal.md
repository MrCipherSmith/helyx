# Flow Journal

- 2026-08-03T10:50:26.414Z - flow created
- 2026-08-03T10:50:55.702Z - frozen: 10 criteria; checksum recorded
- 2026-08-03T10:50:55.790Z - started
- 2026-08-03T10:50:55.880Z - task-added: T5: dupes reports exactly one, the documented one
- 2026-08-03T10:50:55.970Z - task-added: T6: behaviour unchanged at all seven call sites
- 2026-08-03T10:50:56.054Z - task-done: T1: Collect remaining context
- 2026-08-03T10:56:02.417Z - task-done: T2: Implement per plan
- 2026-08-03T10:56:02.509Z - task-done: T3: Add/adjust tests and make them pass
- 2026-08-03T10:56:02.593Z - task-done: T5: dupes reports exactly one, the documented one
- 2026-08-03T10:56:02.679Z - task-done: T6: behaviour unchanged at all seven call sites

## The detector caught me mid-flow

After the first pass of rewiring, `bun run dupes` still reported three, not
one. Two of them were copies I had missed while removing them:

- `claude/client.ts` carried the `<think>` pattern **twice** — I replaced the
  first and moved on — and `scripts/supervisor.ts` had a second occurrence
  formatted across three lines, which my single-line replacement did not
  match.
- `bot/callbacks.ts` still validated the skill name inline; my first patch of
  that file silently did nothing because its import insertion threw before the
  write.

Both are the exact failure `shared-definitions` describes: an extraction that
leaves a consumer behind makes divergence *more* likely, since the shared
version gets maintained and the leftover does not. This time the tool found it
in the same sitting rather than eight review rounds later.

## Verification (T5, T6)

| Task | Result |
|---|---|
| T5 | `bun run dupes` reports **1** — the `unquote` idiom, documented at both sites |
| T6 | all three extracted behaviours identical to the inline originals across 21 inputs, checked by running old and new side by side |

## The one that stays

`/^["']|["']$/g` in `utils/skill-distiller.ts` and `utils/tools-reader.ts`.

Not shared knowledge: the two parsers read different formats — skill
frontmatter and tool metadata — and if one changed its quoting convention the
other would have no reason to follow. Extracting it would invent a dependency
and imply a rule that does not exist, which is worse than the duplicate.

Both sites now carry a comment saying so. The report's floor is one and known,
which is the point: a detector that always shows five findings is background,
and the sixth arrives invisible.

## Codex review, 2026-08-03

Verdict: APPROVE WITH SUGGESTIONS — no blockers. All three suggestions taken,
because each was the theme of this very flow and merging past them would have
been the wrong lesson.

| # | Suggestion | Outcome |
|---|---|---|
| 1 | The skill-name regex also appears in `prompts/skill-distillation.md` — a copy the detector cannot see, since it only scans TypeScript | **Fixed by a parity test.** If the two drift, the model confidently produces names the validator rejects. The test asserts the prompt still quotes the rule and that the implementation agrees on the boundaries. |
| 2 | `claude/client.ts` duplicates the `<think>`/`</think>` literals in its streaming path | **Fixed.** The tags are exported from `utils/llm-output.ts` and the block pattern is built from them. The streaming path needs the tags rather than the pattern — it decides token by token and cannot wait for a closing tag — which is why it had its own copies. |
| 3 | The tests cover the utilities but not the consumer contracts | **Partly fixed.** `durationOrHour` is exported and its fallback-to-an-hour contract is tested. The logger's `process.exit` and the callback's error message still are not; both need the fixture layer that is step 2 of the plan. |

Suggestion 1 is the more interesting one. The detector reads TypeScript, so a
rule restated in a prompt, a README or a shell script is invisible to it — and
`scripts/run-cli.sh` building a `sup:` callback payload by hand is the same
class. Recorded as a limit of the tool rather than left to be rediscovered.

Final: `bun run dupes` reports 1, the documented one. 720 tests.
