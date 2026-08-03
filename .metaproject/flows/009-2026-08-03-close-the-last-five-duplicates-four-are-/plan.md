# Implementation Plan

Status: agreed

## Approach

Four modules, each named for what it defines rather than for where the code
came from. A single `shared.ts` would be the drawer that made this a problem
in the first place.

- `utils/skill-format.ts` — the skill file format: the name rule and the
  inline-shell token. Both belong to the same document format, and the
  distiller and the preprocessor are two readers of it.
- `utils/duration.ts` — `parseDuration(value)` returning milliseconds, not
  just the pattern. Both call sites match and then convert separately, so
  extracting only the regex would leave the conversion duplicated and the
  units unstated.
- `utils/llm-output.ts` — `stripReasoning(text)`. The `<think>` block belongs
  to the model's output format; neither the Anthropic client nor the
  supervisor's Ollama call owns it.

The fifth stays where it is, with a comment at each site saying it is
deliberate and why. Per `shared-definitions`, the rule is to connect places
that must agree — and these two must not.

## Steps

1. The three modules, with functions rather than bare patterns where the
   callers do the same work after matching.
2. Rewire all seven call sites; remove every copy.
3. Tests for each module.
4. Comments at the two `unquote` sites recording the decision.

## Verification (flow tasks, not prose)

- T5: `bun run dupes` reports exactly one duplicate — the documented one — and
  a note in the journal names it.
- T6: the three behaviours are unchanged, checked against the current call
  sites: a rename that was rejected before is still rejected, a duration that
  parsed before still parses to the same milliseconds, and a `<think>` block is
  still removed the same way.

## Risks

- `parseDuration` returning milliseconds means both call sites stop doing their
  own arithmetic. That is the point, but it is where an off-by-1000 would hide,
  so the test states the expected millisecond value for each unit rather than
  comparing the two implementations to each other.
- `bot/callbacks.ts` validates the name inline at a rename prompt. Its error
  message must not change, only the predicate behind it.
