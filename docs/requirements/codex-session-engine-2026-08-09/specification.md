# Specification — Codex as a Second Session Engine

Version: 1.0.0

## Module Identity

No single new module — this feature touches the process-lifecycle layer
(`cli.ts`, `scripts/run-cli.sh`, `scripts/tmux-watchdog.ts`,
`scripts/supervisor.ts`), the DB (`projects` table), the Telegram command
surface (`bot/commands/`), and the channel (`channel/poller.ts`,
`channel/status.ts`). Listed below by area, in build order per `prd.md`
§Recommendation.

## FR1 — Storage and Telegram surface

### Schema

```sql
ALTER TABLE projects ADD COLUMN IF NOT EXISTS engine TEXT NOT NULL DEFAULT 'claude'
  CHECK (engine IN ('claude', 'codex'));
```

A new column, not a new table — `providers` (migration 46) models
*backends reachable through the Anthropic protocol*; an engine is *which
binary runs at all*, orthogonal, and every existing `provider_id`/`model`
value stays meaningful exactly when `engine = 'claude'`. No migration of
existing rows needed: the default keeps every current project unchanged.

### Command surface

New `bot/commands/engine.ts`, `handleEngine` — same registration shape as
`handleProviders` (`bot/handlers.ts:249-251` for the precedent):

```ts
b.command("engine", async (ctx) => {
  const { handleEngine } = await import("./commands/engine.ts");
  await handleEngine(ctx);
});
```

Menu entry in `bot/commands/menu.ts` beside `providers` (`"🔌 Providers"`,
`bot/commands/menu.ts:39`) — e.g. `"⚙️ Engine"`. Callback routing added to
`bot/callbacks.ts` alongside `handleProviderCallback`/
`handleProjectModelCallback` (`bot/callbacks.ts:53-57`).

Command menu registration in `main.ts` beside the existing `providers`
entries (`main.ts:60,79`).

### Why a separate command instead of folding into `/providers`

A provider picker answers "which backend, for the Anthropic-shaped
binary." An engine picker answers "which binary." Merging them means every
provider-menu screen needs a conditional for "does this option make sense
given the current engine," permanently, for one feature that changes
rarely. Two small commands stay simpler than one command with a hidden
mode.

## FR2 — `run-cli.sh` design (decision needed before implementation)

Two options, not a foregone conclusion — `prd.md` §Recommendation asks for
this to be decided before FR2 starts, because starting down one path and
switching means rewriting, not extending.

### Option 1 — one script, engine branch

`run-cli.sh` gains an early `ENGINE=$(bun scripts/resolve-engine.ts "$(pwd -P)")`
call (sibling to the existing `resolve-provider-env.ts` call,
`run-cli.sh:58-63`) and branches at the launch line
(`run-cli.sh:134-163`): `claude ...` unchanged for `claude`, a new
`codex ...` invocation for `codex`. The restart-loop, rate-limiter, and
crash-escalation Telegram message (`run-cli.sh:77-176`) stay shared and
unmodified — they do not reference `claude` by name except in the
crash-escalation message text, which would need `$ENGINE` interpolated in
one place.

**Risk:** the "watch for the dev-channel confirmation prompt" block
(`run-cli.sh:140-157`) is Claude-Code-specific and must not run for a
Codex launch; Codex likely has its own first-run behaviour that has not
been observed (`review-focus.md` R3). A single script now carries two
engines' worth of "how do I know this thing finished starting"
special-casing, which is exactly the kind of accretion that made the
Claude-only version of this script need `docs/restart-problem.md`-level
care already.

### Option 2 — sibling script, shared helper

A new `scripts/run-codex.sh`, and the restart-loop/rate-limiter/
crash-escalation logic extracted from `run-cli.sh` into a sourced helper
(e.g. `scripts/lib/restart-loop.sh`) both scripts call, parameterised by
the launch command and the engine-specific "did it finish starting" check.
`cli.ts`'s `startWindow()` (`cli.ts:1473-1504`) picks which script to run
based on the project's `engine` value (a small addition — it already
resolves the project's path and command there).

**Trade-off:** more files, one extraction that touches the currently
single-purpose `run-cli.sh` even for `claude`-only projects (behaviour
must be verified unchanged after the extraction — a regression here
affects every project, not just ones that opt into Codex). In exchange,
neither script accumulates the other engine's special cases, and a bug in
Codex's startup detection cannot regress Claude's.

**Recommendation for whoever decides this:** Option 2, on the same
principle `docs/requirements/codex-provider-2026-08-09` used for the
proxy design — new engine-specific behaviour in a new file, not
conditionals threaded through a script that already carries real
production weight for every existing project.

## FR3 — MCP wiring

Mirrors the existing registration (`cli.ts:1948`,
`claude mcp add --transport http`), but via `codex mcp add`. Concretely,
to be verified rather than assumed (`review-focus.md` R2):

1. Does `codex mcp add <name> --transport http <url>` exist with the same
   shape, or does Codex only support stdio MCP servers? (`codex mcp add
   --help` was not run in this package's research — a one-command check
   that should happen before FR3 is estimated as "done" anywhere.)
2. Can a custom header (`X-Helyx-Project`, carrying `HELYX_PROJECT_PATH`)
   travel with an HTTP-transport MCP registration in Codex the way it does
   for the shared `playwright`/`context7` services (`cli.ts:1941-1950`)?
   If not, project identity needs a different channel — e.g. a
   `CODEX_PROJECT_PATH` env var read by a Codex-side hook (Codex's own
   `features.hooks`/`session_start` mechanism, already present in this
   host's `~/.codex/config.toml`) that sets the equivalent header, or a
   distinct per-project MCP server URL instead of one shared one.
3. Registration scope: `claude mcp add` writes to `~/.claude.json`,
   global. `codex mcp add` likely writes to `~/.codex/config.toml`, also
   global (the existing file already lists this repo under
   `[projects."/home/altsay/bots/helyx"]` with `trust_level = "trusted"`,
   confirming project-scoped *trust* exists in that file's schema — MCP
   server registration's own scoping needs the same one-command check as
   above).

Until (1)-(3) are answered, FR3 is not "config, ten minutes" — it is "one
verification pass, then config."

## FR4 — Health monitoring

`tmux-watchdog.ts` and `scripts/supervisor.ts` need each project's
`engine` (a small join/lookup, same shape as their existing project-config
reads) and an engine-keyed detector table instead of the current
Claude-only constants (`SPINNER_RE`, `VIM_RE`, `NANO_RE`, `CREDENTIAL_RE`,
`CRASH_RE`, `DEV_CHANNEL_SIGNAL_RE`/`DEV_CHANNEL_CONFIRM_RE`,
`tmux-watchdog.ts:156-178`).

**Blocking prerequisite, not a detail:** none of a Codex-equivalent
detector set can be written without first observing Codex's actual
interactive TUI — its spinner (if any), its permission-prompt text, its
crash output shape. This package's research ran `codex exec` (structured
JSON events) and read `--help` output; it did not run interactive `codex`
in a tmux pane and capture a screen. That capture is the concrete first
step of FR4, before any regex is written — see `review-focus.md` R3.

`classifyCodexFailure()` (`services/reviewer-service.ts:377-433`) is the
right starting point for whatever Codex's own limit/auth/crash wording
turns out to be on screen, since it already knows Codex's vocabulary for
those conditions from the `exec`/`review` non-interactive paths — but it
was written against `stdout`/`stderr` of a finished process, not a live
TUI's scrollback, and porting its patterns to `tmux capture-pane` output
needs verification, not just a direct reuse.

## FR5 — Context handoff (reuse, not a new mechanism)

No new injection code is specified here. `channel/poller.ts`'s existing
mechanism (`docs/requirements/session-context-injection.md` FR1-FR5)
already does exactly what this package needs on every process restart:
Tier 1 (recent `memories` summary) or Tier 2 (raw history) prepended to
the first message delivered to a freshly-started process, keyed on
`"${sessionId}:${clientId}"` so it fires exactly once per new process.

**What has to be true for this to cover an engine switch, not just a
same-engine restart:**
- The new engine's process must register a new `clientId` in
  `sessions.client_id` the same way a restarted Claude process does, so
  the injection guard's key changes and fires again. Whatever wires FR3
  (a Codex session connecting to helyx-channel) needs to update this
  field exactly where a Claude reconnect does — not a new code path, the
  *same* one, or the switch silently gets no injected context at all.
- FR3 must be real: injection only helps if Codex's first message ever
  passes through `channel/poller.ts`'s delivery path in the first place.
- The summary Tier 1 reads must actually exist by switch time. A
  limit-triggered switch may catch the outgoing Claude session mid-turn,
  before any on-exit summarization (`summarizeWork`) has run — unlike a
  clean restart, where there was time for one. Whether the switch flow
  needs to *force* a summary generation before/during the handoff (adding
  latency) or accept a Tier-2 raw-history fallback for this specific case
  is an open call for whoever implements this, not answered here.

## FR6 — Limit detection, both directions

### Claude → Codex (exists, needs one new consumer)

`channel/status.ts`'s `noteApiError()` → `services/limit-marker.ts`'s
`startLimit()` already fires on exactly the condition this feature reacts
to. New: a consumer of the same marker that, instead of (or alongside)
`LimitHold` pausing delivery, surfaces a Telegram button ("Switch this
project to Codex?") when a limit marker is written for a project with no
`codex` engine already active. No changes to `limit-marker.ts` itself —
it is read, not modified.

### Codex → Claude (does not exist)

No detector reads a Codex session's output for its own limit/auth/crash
condition today. `classifyCodexFailure()` covers `codex exec`'s finished
`stdout`/`stderr`, built for the one-shot reviewer path — an interactive
session's live screen is a different signal entirely and has not been
captured (`review-focus.md` R1 elaborates what would need to be measured
before this can be estimated with any confidence, the same way
`services/limit-marker.ts`'s own docstring cites twelve measured Claude
limit events as its evidence base — this direction currently has zero).

## Acceptance Criteria

- **AC1** — A project with `engine = 'codex'` launches `codex`
  (interactively) in its tmux window/pane instead of `claude`, through
  whichever of FR2's two options was chosen, with the existing
  crash-loop/rate-limit protection intact for both engines.
- **AC2** — `/engine` lets the operator read and change a project's engine
  from Telegram, mirroring `/providers`'s UX without sharing its code path.
- **AC3** — A `reply`/`remember`/etc. call from a Codex-driven session
  reaches the operator through the same Telegram delivery the Claude path
  uses — proof FR3's MCP wiring is real, not just configured.
- **AC4** — `tmux-watchdog.ts`/`scripts/supervisor.ts` correctly report a
  Codex-driven project's health (running / hung / crashed) using
  Codex-specific detectors verified against a real captured screen, not
  detectors adapted from Claude's by assumption.
- **AC5** — Switching a project from `claude` to `codex` results in the
  first Codex-side message containing the same kind of context block a
  Claude restart already gets — verified by checking `injectedSessions`'
  key changes on the new `clientId`, not by eyeballing one manual test.
- **AC6** — A Claude limit firing on a project offers a Codex switch via
  Telegram button; accepting it performs the switch; declining it falls
  back to today's behaviour (`LimitHold` holds the queue) unchanged.
- **AC7** — No project with `engine` left at its default (`claude`)
  changes behaviour in any way — verified by the existing test suite for
  `run-cli.sh`/`tmux-watchdog.ts`/`scripts/supervisor.ts` passing
  unmodified, the same "zero-line diff for the untouched path" bar
  `docs/requirements/codex-provider-2026-08-09` set for its own design.
