# status line classifiers — a tool call that mentions waiting is shown as waiting

Status: formalized
Source: user description (заход 5 of the coverage programme)

## Problem

`channel/status.ts` is the third-worst hotspot (cyclomatic 249) and holds the
five pure functions that decide what the operator sees in the live status
message while Claude works. None is tested.

`detectPhase` decides the emoji at the head of that line. Its first branch
scans the **whole** stage text — which is multi-line pane output, tool calls
included — for the words `permission`, `approve` or `waiting`, and returns the
`waiting` phase (💬) if any appears anywhere:

```ts
const s = stage.trim().toLowerCase();
if (s.includes('permission') || s.includes('approve') || s.includes('waiting'))
  return 'waiting';
```

Only after that does it look at the tool line to classify what is actually
happening. Demonstrated against the real logic:

| Stage | Shown | Should be |
|---|---|---|
| `● $ grep -rn "waiting" src/` | 💬 waiting | ⚡ running |
| `● Read: docs/permissions.md` | 💬 waiting | 📖 reading |
| `● $ npm run approve-release` | 💬 waiting | ⚡ running |
| `● Read: src/index.ts` | 📖 reading | 📖 reading ✓ |

💬 is the signal the operator watches for — it means the session is blocked on
a permission prompt and needs a human. Any tool call whose text happens to
contain one of three common English words raises it falsely, and this codebase
in particular is full of them: `bot/callbacks.ts` handles permissions,
`permission-flow.test.ts` exists, `dashboard-api.ts` serves `/api/permissions`.

The other four are untested rather than wrong:

- `parseTokenCount` — `"2.5k tokens"` → 2500. Its character class accepts
  several dots, so `"1.2.3 tokens"` reaches `parseFloat` and silently becomes 1.
- `formatElapsed` — seconds under a minute, `Nm Ss` above; an hour reads as
  `60m 0s`.
- `getSpinnerIcon` — the stale-heartbeat ⚠️ and the frame cycle.
- `computeSignature` — FNV-1a, used to suppress duplicate edits.

## Expected Outcome

The five decisions live in an importable module with tests, `status.ts` calls
them, and `detectPhase` only reports `waiting` when the stage is actually a
permission prompt rather than a tool call that mentions one.

## Out of Scope

- `StatusManager` itself — it holds Telegram state and timers, and covering it
  needs a fixture for both.
- The status message's layout, wording and emoji vocabulary.
- Whether the spinner intervals and thresholds are the right numbers.
