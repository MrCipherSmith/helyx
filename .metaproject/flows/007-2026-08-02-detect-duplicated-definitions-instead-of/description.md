# detect duplicated definitions instead of relying on noticing them

Status: formalized
Source: user request after the заходы 1–6 retrospective

## Problem

Six flows in a row, the bug was the same shape: one piece of knowledge living
in several places and quietly diverging.

| Flow | The duplicated thing | How it was found |
|---|---|---|
| 001 | five `stripAnsi` implementations, three of them narrower | reading the call sites |
| 005 | the permission-dialog rule, restated four times, wrong each time | four review rounds |
| 006 | the edit-guard protocol, written out in three places | three review rounds |

Every one was found by a person reading code, not by a check. That is the
part worth fixing: attention does not scale and does not survive a long
session.

**Demonstrated on this repository, right now.** A first prototype of the
detector was run against `main` and immediately found a duplicate that flow
006 had left behind after *five* review rounds specifically about that rule:

```
/do you want to proceed\?/i   scripts/tmux-watchdog.ts, utils/permission-prompt.ts
/❯\s*1[.)]\s*yes/i            scripts/tmux-watchdog.ts, utils/permission-prompt.ts
```

The watchdog's `detectPermissionPrompt` had been switched to the shared
predicate, but a second consumer forty lines further down still used local
copies. Nobody saw it, in five passes, because everyone was reading the diff
rather than looking for what remained.

## Expected Outcome

A check that reports the same class of finding without anyone having to look
for it, run from `package.json` and cheap enough to run every time.

## Out of Scope

- Detecting *paraphrased* duplication. The prototype finds identical literals;
  flow 005's rule was restated in different words each time and this would not
  have caught it. Stated plainly rather than oversold — it closes the common
  case, not the class.
- Failing a build. This reports; whether it gates is a separate decision, and
  a check that blocks before it has earned trust just gets disabled.
- Promoting it into the `keryx health` module so every project gets it. That
  is the right home eventually and is recorded as the follow-up.
