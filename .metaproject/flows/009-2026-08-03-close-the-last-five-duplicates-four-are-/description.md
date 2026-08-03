# close the last five duplicates — four are shared knowledge, one is not

Status: formalized
Source: the plan agreed after flow 008 (step 1 of four)

## Problem

`bun run dupes` reports five duplicated patterns. Taking the report to a known
floor is what makes it useful: a detector that always shows five findings is
background, and the sixth — the real one — arrives invisible.

| Pattern | Files | Is it shared knowledge? |
|---|---|---|
| `/^[a-z][a-z0-9-]{0,63}$/` | `bot/callbacks.ts`, `utils/skill-distiller.ts`, `utils/skill-handlers.ts` | **Yes** — what a skill may be called. Three places validating the same name, one of them by hand at a rename prompt. |
| ``/!`[^`\n]+`/`` | `utils/skill-distiller.ts`, `utils/skill-preprocessor.ts` (twice, once with `g`) | **Yes** — the inline-shell token. The distiller warns about it, the preprocessor expands it; if the syntax moved they would have to move together. |
| `/^(\d+)(m\|h\|d)$/` | `bot/commands/tmux-log.ts`, `scripts/tmux-session-logger.ts` | **Yes** — the duration argument two CLIs accept. Both then convert to milliseconds, separately. |
| `/<think>[\s\S]*?<\/think>/g` | `claude/client.ts`, `scripts/supervisor.ts` | **Yes** — the reasoning block hybrid models emit. It belongs to the model's output format, not to either caller. |
| `/^["']\|["']$/g` | `utils/skill-distiller.ts`, `utils/tools-reader.ts` | **No** — see below. |

The fifth is a coincidence of idiom rather than shared knowledge. The two
parsers read different formats — skill frontmatter and tool metadata — and if
one changed its quoting convention the other would have no reason to follow.
Extracting it would connect two things that are not connected, which is worse
than the duplicate: it invents a dependency and implies a rule that does not
exist.

## Expected Outcome

Four shared definitions, each in a module named for what it defines, with
every copy removed. The fifth documented as deliberate, so the report's floor
is one and known.

## Out of Scope

- Changing any validation, expansion or parsing behaviour. Same patterns, same
  answers; this moves where they live.
- An allowlist in the detector. A floor of one with a written reason is
  cheaper and harder to abuse than a suppression list.
