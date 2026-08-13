# PRD — Codex as a Second Session Engine

Version: 1.0.0

## Problem

A project's Claude Code session is a single point of failure against
Anthropic's usage limits. `services/limit-marker.ts` already tells the
difference between a limit and a hang and holds queued messages until the
marker expires (Flow 061) — but "hold and wait" is the only response that
exists. The operator already pays for and is already authenticated against
a Codex subscription (`bot/commands/codex.ts`, `/codex_setup`) that sits
idle while a project waits out a Claude limit that can be hours away
(`LIMIT_GRACE_DEFAULT_MS` = 30 minutes when no reset time is stated,
`LIMIT_RESET_MAX_AHEAD_MS` = 24 hours when one is).

## Goal

Let a project's session switch, on the operator's command (or on explicit
confirmation when a Claude limit fires), from `claude` to `codex` as the
process running in that project's tmux window — and back — while carrying
forward as much of the working context as the two products' incompatible
session formats allow.

## Users

The operator (single user), through Telegram commands/buttons and,
once switched, through the same helyx-channel conversation surface —
ideally indistinguishable in *how* messages are sent and received, even
though *what answers* changes engine.

## Requirements

- **FR1 — Per-project engine selection.** A project has an `engine` value
  (`claude` | `codex`), analogous to but independent of `provider_id`.
  Selectable from Telegram, mirroring `/providers`'s UX
  (`bot/commands/providers.ts`, `handleProviders`) without reusing its
  code — a provider and an engine are different axes (a `codex` engine has
  no `providers` row at all; `provider_id`/`model` remain meaningful only
  when `engine = 'claude'`).
- **FR2 — `run-cli.sh` becomes engine-aware without becoming
  Claude-and-Codex-aware in the same file.** The existing restart-loop,
  crash-escalation, and rate-limiting logic in `run-cli.sh` is
  battle-tested and engine-agnostic in spirit (it does not care *why* a
  process died, only that it did). The engine-specific parts — the
  `claude`/`codex` argv, and each engine's own first-run
  prompt-confirmation behaviour — must not be forced into one script's
  if/else without a design decision on how much is actually shared. See
  `specification.md` §"run-cli.sh design" for the two options weighed.
- **FR3 — helyx-channel reaches a Codex session the same way it reaches a
  Claude session.** Registered via `codex mcp add` (mechanism confirmed to
  exist; end-to-end attachment not yet tested — `review-focus.md` R2),
  carrying the same project-identity mechanism (`HELYX_PROJECT_PATH` or
  equivalent) so the bot-side code that answers a `reply`/`remember`/etc.
  call does not need to know which engine sent it.
- **FR4 — Health and limit monitoring covers a Codex-driven window.**
  `tmux-watchdog.ts` and `scripts/supervisor.ts` must know a given
  project's engine and apply the right detector set. Claude's detectors
  (`SPINNER_RE`, `VIM_RE`, `CREDENTIAL_RE`, the dev-channel prompt regexes)
  are `codex exec --help`-verified to not apply to Codex's actual TUI,
  because that TUI's screen output has not been observed in this package's
  research at all — see `review-focus.md` R3.
- **FR5 — Context carries forward on a switch, on the terms
  `channel/poller.ts`'s existing injection mechanism already sets, not
  better ones invented for this package.** When the new engine's process
  delivers its first message, the same Tier-1 (recent summary)/Tier-2
  (raw history) injection that already runs on every Claude→Claude restart
  should run unmodified — contingent entirely on FR3 (Codex must receive
  messages through the same delivery path the injection guard sits in
  front of). No new context-generation mechanism is proposed; see
  **Recommendation** for why extending the existing one is preferred over
  building a Codex-specific bridge.
- **FR6 — The Claude→Codex trigger reuses `noteApiError`/`startLimit`; the
  Codex→Claude trigger does not exist yet and must be built.** `noteApiError`
  already fires on the exact condition ("Claude hit a limit") this feature
  cares about for one direction. The reverse condition ("Codex hit its own
  limit, or its login expired") has no detector today — `classifyCodexFailure()`
  covers `codex exec`'s stdout/stderr, not an interactive session's
  on-screen or session-log text, which have not been captured in this
  package's research. See `review-focus.md` R1.
- **FR7 — Manual trigger first.** The switch is operator-initiated
  (a command, or confirming a Telegram button shown when a Claude limit
  marker is written) in the first build. Automatic, unattended switching
  is explicitly deferred — see **Risks** R-auto and the prior session note
  in [[architecture_codex_review_vs_session_engine]].

## Success Criteria

The operator can move a project from `claude` to `codex` (and back) with
one Telegram interaction; the new engine's first reply reflects the
existing context-injection summary, not a blank "what are we working on?";
a Codex-driven session's crash or hang is caught by the watchdog/supervisor
the same way a Claude one is, not silently; nothing about a project that
has never touched this feature changes.

## Risks

- **R-fidelity — Codex is not Claude, and no amount of context injection
  makes it feel like the same assistant mid-thought.** Different tools,
  different permission model (Codex's own sandbox/approval flow, not
  Claude Code's), different conversational style. `FR5`'s injection gives
  the new engine a *briefing*, the same imperfect thing it already gives a
  restarted Claude session — this package does not claim more than that,
  and neither should whoever reviews it.
- **R-detection-asymmetry — the two trigger directions are not
  symmetric in cost.** Claude→Codex reuses a mechanism that already ships
  in production (`noteApiError`). Codex→Claude requires new detection work
  against a CLI whose interactive-mode failure text this package has not
  observed. Treating the two directions as "the same feature, twice" would
  understate the second by a wide margin — see `review-focus.md` R1 for
  exactly what would need to be built and verified.
- **R-watchdog-blind-spot — a Codex window is invisible to today's health
  checks until FR4 ships.** Shipping FR1-FR3 without FR4 would put a
  project into a state supervisor/watchdog do not understand: `SessionManager`
  and the crash-escalation Telegram alert in `run-cli.sh` would keep firing
  language written for `claude`'s output against a screen that never
  produces it. FR4 is not an enhancement to schedule later; shipping
  without it is shipping a session the operator cannot get told is broken.
- **R-mcp-unverified — FR3 is the hinge the rest of the design leans on,
  and it has not been tested.** If `codex mcp add` cannot carry the
  `HELYX_PROJECT_PATH`-equivalent identity, or if Codex's MCP client
  handles tool schemas differently enough that `reply`/`remember`/etc.
  misbehave, several other requirements (FR5's context injection depends
  on messages reaching Codex through the tracked delivery path at all)
  degrade or fail quietly. See `review-focus.md` R2.
- **R-auto — automatic switching on limit detection is not proposed for
  the first build**, per FR7. The failure mode of getting this wrong —
  a session silently continuing on a different engine mid-conversation,
  answering in a different voice with different tools, without the
  operator having asked for it — is worse than the problem this package
  solves. Kept as an explicit non-goal, not an oversight.
- **R-account — same non-engineering judgment call as
  `docs/requirements/codex-provider-2026-08-09`'s R2**: continuous
  interactive use of a ChatGPT-subscription entitlement through this
  feature is, if anything, closer to Codex's own intended use (a real
  interactive coding session, not a silent backend) than the proxy
  design was — worth noting as the more defensible of the two designs on
  this specific axis, not a reason to skip the operator's own judgment.

## Recommendation

Build in the order the requirements are numbered, because each is a
precondition for the next being testable: FR1 (schema/UX) → FR2
(`run-cli.sh`) → FR3 (MCP wiring — the hinge, verify early) → FR4 (health
monitoring, cannot ship without it per R-watchdog-blind-spot) → FR5
(confirm injection actually reaches a Codex session once FR3 is real,
rather than assuming it does) → FR6 (accept the Claude→Codex direction is
close to free, and scope the Codex→Claude direction as its own
sub-investigation before committing to a delivery date for it) → FR7
(ship manual-only; revisit automatic later, separately, with its own
review).

Two things should happen before implementation starts, not after:
`review-focus.md`'s R1-R3 answered by whoever reviews this package (they
are framed as questions, not settled facts), and a decision on
`specification.md`'s run-cli.sh design options — that decision changes
how much of FR2 is new code versus shared code, and picking it late means
rewriting rather than extending whichever path was started first.
