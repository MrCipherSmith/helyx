# Review Focus — Claims Worth Attacking Independently

Version: 1.0.0

Written at the operator's explicit request: this package's weak and
thin-evidence points, named rather than smoothed over, so a separate
review pass (another sub-agent, another model) has something concrete to
push on instead of re-deriving the whole package from scratch. Each item
is a falsifiable claim or an open question, not a finished fact — treat
"confirmed" language elsewhere in this package's other files as "confirmed
by one research pass on 2026-08-09," not as independently verified.

## R1 — Codex→Claude limit detection: zero evidence base, unlike its counterpart

**Claim in the package:** `specification.md` FR6 says the Claude→Codex
direction reuses a production mechanism (`noteApiError`/`startLimit`) and
the Codex→Claude direction "does not exist yet and must be built."

**Why this is the single biggest unknown in the package:**
`services/limit-marker.ts`'s own docstring cites its evidence base
explicitly — "twelve limit events in this project's transcripts between
2026-07-07 and 2026-08-08." That module exists *because* real limit text
was captured and studied. Nothing equivalent exists for Codex's
interactive mode: this package's only Codex research
(`docs/requirements/codex-provider-2026-08-09/spike-findings.md`) ran
`codex exec --json`, a structured, non-interactive surface, and never
triggered a real quota exhaustion — the spike's three calls were
deliberately trivial and succeeded. What Codex's *interactive* TUI
displays when a ChatGPT subscription runs out, or when its login expires
mid-session, has never been observed by anyone on this project as far as
this package's research found.

**What would resolve it:** deliberately exhaust or simulate a Codex
account limit (or find documentation of Codex's own error text/exit
behaviour) and capture the actual on-screen or session-log wording, the
way `limit-marker.ts`'s design was informed by real captured Claude limit
messages.

**Suggested review angle:** treat this as a research task, not a code
review task — a reviewer with web access checking Codex CLI's public
documentation/changelog/issue tracker for how it surfaces quota exhaustion
would answer more of this than re-reading the code in this repo.

## R2 — FR3 (MCP wiring to Codex) is the hinge nothing downstream has tested

**Claim in the package:** `codex mcp add` exists as a subcommand
(verified) and can plausibly carry an HTTP-transport registration with
project-identifying headers the way `claude mcp add` does (not verified).

**Why it matters more than its one paragraph in `specification.md`
suggests:** FR5 (context injection) is written as "this already works,
just make sure Codex goes through the same path" — that framing is only
true if FR3 is true. If Codex's MCP client only supports stdio transport,
or doesn't forward custom headers, or handles tool schemas (input_schema
shapes, streaming tool results) differently enough that `reply`/
`remember`/etc. misbehave, the honest cost of this package rises a lot:
not just "write a header differently" but "helyx-channel needs a
Codex-specific attachment mode," which cascades into FR4's health checks
(how would the watchdog know a Codex MCP connection is alive vs. silently
broken?) and FR6's Claude→Codex switch flow (what does "switch succeeded"
even mean if the new session can't call `reply`?).

**What would resolve it:** the single command `codex mcp add --help`, not
run in this package's research, followed by an actual `codex mcp add`
against a running helyx-channel instance and one real tool call from
inside an interactive `codex` session.

**Suggested review angle:** this is the one item in this package worth a
throwaway spike before anything else, the same way
`docs/requirements/codex-provider-2026-08-09` spiked its own hinge
assumption before writing a full daemon design around it. A reviewer
should ask whether this package should have run that spike itself before
being written this thoroughly — that is a legitimate process critique,
not just a content one.

## R3 — Codex's interactive TUI has never been visually observed by this project

**Claim in the package:** FR4 says Claude-specific detectors
(`SPINNER_RE`, `VIM_RE`, dev-channel prompt regexes) don't apply to Codex
and new ones are needed.

**What's actually behind that claim:** nothing but inference. This
package's research ran `codex exec` (JSON events, no screen) and read
`--help` output. Nobody has run bare `codex` in a tmux pane, watched what
its spinner/permission-prompt/crash screens look like, or confirmed
whether it even has analogues to Claude Code's "development channels"
first-run disclaimer that `run-cli.sh`'s existing watcher loop
(`run-cli.sh:140-157`) exists to auto-confirm. FR4 is correctly flagged in
`specification.md` as blocked on this observation — this entry exists so
a reviewer double-checks that the blocking, not just the requirement, is
taken seriously before implementation starts.

**What would resolve it:** thirty minutes with an interactive `codex`
session in a real tmux pane, capturing screens the way
`tmux-watchdog.ts`'s own test fixtures were presumably built (worth
checking `tests/unit/watchdog-detectors.test.ts` for the *method* the
existing Claude detectors were validated with, and reusing that method for
Codex rather than inventing a new one).

## R4 — FR5's `clientId`/`injectedSessions` mechanics, described from a doc, not re-verified against current code

**Claim in the package:** switching engines triggers `channel/poller.ts`'s
existing context injection because the new process registers a new
`sessions.client_id`, changing the `"${sessionId}:${clientId}"` guard key.

**Where this claim actually comes from:** `docs/requirements/
session-context-injection.md`, a design document dated "verified against
the code on 2026-07-31" — over a week old relative to this package. This
package's own research read that document and `services/limit-marker.ts`
(which references the same poller) but did **not** re-read
`channel/poller.ts` or `sessions/manager.ts` directly to confirm the
`client_id` update path still matches that description, or that an engine
switch (as opposed to a same-binary reconnect) would go through the same
`adoptOrRename`-style logic that document assumes.

**What would resolve it:** read `channel/poller.ts` and
`sessions/manager.ts` directly against current `main`, specifically how
`client_id` gets set on a new process connecting, and confirm nothing
there assumes the reconnecting process is `claude` specifically (a check,
an argv inspection, a hardcoded string) that an engine switch would fail
silently against.

## R5 — The crash-escalation and health-monitoring UX assumes engine is visible where it currently isn't

**Claim in the package:** `run-cli.sh`'s existing Telegram
crash-escalation message (`run-cli.sh:98-119`, currently reads
`ANTHROPIC_BASE_URL` to name a misbehaving provider) would need `$ENGINE`
interpolated once. Similarly, `/monitor`
(`bot/commands/monitor.ts`) and `process_health` rows are provider/daemon
keyed today, not engine keyed.

**Why this is worth a second look:** this package treats it as a small
addition throughout, but it touches operator-facing text in several
places (`run-cli.sh`'s escalation message, whatever `/engine` reports,
possibly `/monitor`'s per-project line) that all currently assume "this
is a Claude Code session" as ambient context rather than a stated fact.
Missing one of these is a UX bug (a confusing alert), not a functional
one — lower severity than R1-R3, but a reviewer doing a completeness pass
should grep for every place a message is built that names or implies
`claude` and check it against this package's file list.

## R6 — This package and `docs/requirements/codex-provider-2026-08-09` were scoped as alternatives; a reviewer should confirm that boundary holds

**Claim in the package:** the two Codex packages solve the same underlying
problem (Claude limit → keep working via Codex) two different ways, and
building both is not proposed.

**Worth checking:** whether there's a hybrid worth naming that this
package's framing forecloses too early — e.g., using the proxy package's
Option A (Codex as a delegated sub-agent behind `claude`, from that
package's spec) as a *lighter-weight, same-tool-loop-illusion* alternative
to a full engine switch for cases where the operator wants "keep going a
little longer" rather than "hand the whole session to a different
product." This package does not evaluate that middle ground; a reviewer
with fresh eyes on both packages together might find it's worth a third,
smaller option rather than treating "proxy" and "engine switch" as the
only two points on the spectrum.
