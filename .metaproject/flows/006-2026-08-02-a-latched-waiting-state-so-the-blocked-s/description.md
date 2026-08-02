# a latched waiting state, so the blocked-session signal can finally be true

Status: formalized
Source: flow 005 follow-up (заход 6 of the coverage programme)

## Problem

The 💬 phase in the live status line means "this session is blocked on a
permission prompt and needs you". Flow 005 established, by measurement, that
it has never once been true:

- `utils/tmux-monitor.ts` drops both signals the dialog is recognised by —
  `^❯` is in `SKIP_PATTERNS`, and "Do you want to proceed?" is prose that
  falls through `parseLine` to null. The dialog reaches the status line as
  nothing but the tool bullet it asked about.
- `channel/permissions.ts` sets the status itself while a prompt is pending,
  and it reads `Running: npm test` — indistinguishable from ordinary work.

So a blocked session looks like a working one. Flow 005 removed the false 💬
signals; it could not make a true one, and said so.

That flow also tried and reverted the obvious fix — prefixing the handler's
status text. Codex rejected it, correctly: the prefix is written once and the
next monitor poll overwrites the stage; it was set before Telegram delivery;
and neither a send failure nor a timeout cleared it. Half a state machine is
worse than none, because the old behaviour was merely silent and that one
would have latched a lie.

## Expected Outcome

A permission request that reaches the operator shows 💬 for exactly as long as
it is pending, and stops the moment it is answered, denied, times out, or
fails — whichever happens, including on a throw.

## Out of Scope

- Changing `tmux-monitor`'s parsing. Keeping the dialog's prose would change
  what every status shows; the handler knows the answer without it.
- The permission dialog's own Telegram message, its buttons, or its timeout.
- The remaining `StatusManager` surface: this flow adds one flag and one
  branch, and touches nothing else in it.
