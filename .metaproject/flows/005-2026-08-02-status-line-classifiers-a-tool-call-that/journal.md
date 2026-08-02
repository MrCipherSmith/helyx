# Flow Journal

- 2026-08-02T14:12:04.685Z - flow created
- 2026-08-02T14:13:41.073Z - frozen: 10 criteria; checksum recorded
- 2026-08-02T14:13:41.160Z - started
- 2026-08-02T14:13:41.253Z - task-done: T1: Collect remaining context
- 2026-08-02T14:16:51.986Z - task-done: T2: Implement per plan
- 2026-08-02T14:16:52.071Z - task-done: T3: Add/adjust tests and make them pass

## Codex review, 2026-08-02

Verdict: REQUEST CHANGES — one **blocker**, one major. Both accepted.

The blocker is the risk this flow's own plan named and then did not check.
`utils/tmux-monitor.ts` parses the pane before the text becomes `stage`:
`^❯` is in SKIP_PATTERNS, and "Do you want to proceed?" is prose that falls
through every branch of `parseLine` to null. So a permission dialog reaches
`detectPhase` as nothing but the tool bullet it asked about:

```
raw pane                                    →  stage
  ● mcp__docker__docker_container_list (MCP)   ● mcp__docker__docker_container_list (MCP)
  Do you want to proceed?                      (dropped)
  ❯ 1. Yes                                     (dropped)
```

Neither of the two new regexes can match that. The plan listed exactly this
risk in step 5 — "confirm both watchdog and status agree on the same dialog
text" — and the branch was pushed without running it.

**The consequence is the opposite of what the finding assumed.** Measured
rather than reasoned: the old whole-blob word scan cannot see the dialog
either, and the permission handler's own status
(`channel/permissions.ts:231`) reads `Running: npm test`, which classifies as
`running`. So 💬 never fired for a real permission request in either version —
it was a phase that could not be true, and the only thing the old scan
produced was the false positives this flow removes. The same shape as заход
4's unreachable red state.

Fixed properly rather than reverted: the permission handler prefixes its
status when a prompt is going out. It knows — the auto-approve path has
already returned by then — and should not leave a classifier to infer it from
text that was thrown away two modules earlier.

The major finding — that the tests fed `detectPhase` raw pane text and so
passed while production failed — is fixed by exporting `parseStatus` and
asserting the raw-pane → stage → phase contract against the real
implementation.

After the fixes: 598 tests pass (from 594).

### Second Codex pass — the fix was half a state machine

Codex confirmed the historical measurement: the old `detectPhase` also could
not see a real prompt, and 💬 had no genuine detection. But it rejected the
`WAITING_PREFIX` fix, correctly:

- the prefix is written once, and the next tmux/output poll overwrites the
  stage unconditionally (`status.ts:668`, `status.ts:939`);
- it is set *before* Telegram delivery, and a send failure returns without
  clearing it (`permissions.ts:255`);
- the timeout path never clears it either (`permissions.ts:437`).

So it would flicker for one poll interval in the good case and latch a false
"waiting" forever in the bad ones. Half a state machine is worse than none:
the previous behaviour was merely silent, this one would lie.

**Reverted from this flow.** The correct fix is an explicit latched
permission-waiting state in `StatusManager` — set after successful delivery,
suppressing monitor stage replacement while held, cleared on every resolution,
failure and timeout path. That is work inside `StatusManager`, which this
flow's description explicitly placed out of scope, and it touches live
permission handling I cannot exercise end to end. Putting it in here would
also deliver something the frozen acceptance criteria never described, which
is the drift the checksum exists to prevent.

Recorded as the next flow. What this flow ships stands on its own: the false
💬 signals are gone, the classifiers are covered, and the contract test pins
what the monitor actually keeps — which is the thing nobody had written down
and the reason the gap survived this long.
- 2026-08-02T14:37:30.959Z - task-done: T4: Self-review and prepare draft PR

### Third Codex pass — the same mistake a third time

The revert was confirmed clean. One finding remained, and it is the same
error I had already made twice in this flow: **I described a stricter contract
than I implemented.**

`isPermissionPrompt` was documented as using "the same signals
`scripts/tmux-watchdog.ts` uses" and then combined them with **or**. The
watchdog requires both — the question, and a highlighted choice *below* it.
With `or`, `● $ echo "Do you want to proceed?"` becomes `waiting`: a brand new
false 💬, of exactly the class this flow exists to remove.

Fixed: both signals, in order, matching the watchdog. Three tests added — the
shell-command case, the choice-before-question case, and an unhighlighted
choice line.

Three times in one flow, the same shape:

1. planned a rule keyed on "is there a bullet", when the real dialog has one —
   caught by reading the fixture before writing code;
2. claimed the new regexes detect real prompts, when the monitor discards both
   signal lines before they arrive — caught by Codex, and it was the risk this
   plan listed in step 5 and did not run;
3. claimed to share the watchdog's definition while implementing a weaker one
   — caught by Codex.

Every one was a gap between what the comment asserted and what the code did.
Worth recording as the lesson of this flow, more than the fix itself.
