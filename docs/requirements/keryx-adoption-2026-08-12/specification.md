# Specification: Adopting keryx Patterns into helyx

Version: 1.2.0

## Identity

| Field | Value |
|---|---|
| Package | `keryx-adoption-2026-08-12` |
| Kind | standard (cross-cutting adoption decisions) |
| Path | `docs/requirements/keryx-adoption-2026-08-12/` |
| Status | `draft` |
| Source | keryx `af380a6a`, v0.2.16, `/home/altsay/keryx` |
| Areas, in implementation order | A2 action-bound approval · A1 external-boundary scan · A3 archive split · A5 Telegram perimeter · A4 engine connector |

This package owns decisions and contracts. It owns no runtime code, no table, and
no command. Each area names the helyx module that would own its implementation.

## Storage structure

```text
docs/requirements/keryx-adoption-2026-08-12/
  README.md
  prd.md
  specification.md
  policies.md
  implementation-plan.md
  metrics-and-validation.md
  schemas/
    external-boundary-policy.schema.json
    action-approval-grant.schema.json
    engine-connector-entry.schema.json
```

Nothing in this package writes to `.metaproject/`. Execution metrics for the run
that produced it are saved under `.metaproject/data/gdskills/metrics/`, per
`.metaproject/rules/core/execution-metrics.md`.

---

## A2 — Approval bound to an action

### What exists today

`claimRestart` is defined at `scripts/admin-daemon.ts:342` and called from three
places (:416, :494, :522), backed by `utils/restart-lease.ts` with a 15-minute
expiry. It answers exactly one question: *is another restart already running?*
`CLAUDE.md` records that `bun cli.ts bounce` run directly on the host does not
call it at all.

The approval surface is `perm:allow:` / `perm:always:` / `perm:deny:` plus a
request id (`utils/permission-render.ts:46-48`), routed by prefix table
(`utils/callback-route.ts`).

Neither mechanism ties the operator's answer to a description of what was
approved.

### The four properties adopted

From keryx `docs/docs/harness.md` and `src/harness/policy/engine.ts`:

1. A hard `deny` is terminal — no approval, role, or interactivity flips it.
2. An approval authorizes exactly one action, bound to that action's
   fingerprint; a single-use grant is spent once consumed.
3. Headless never silently allows: an `ask` with no live approver becomes a
   `deny`.
4. Structural safety runs before policy — a malformed or unsafe *shape* is
   refused before the allow/ask/deny question is asked at all.

### The fingerprint

Deliberately coarse. A fingerprint over the exact command string would re-ask on
every trivial variation and train the operator to approve without reading —
which is the failure being prevented, arrived at by a different road.

The fingerprint covers **what the operator would notice**:

| Component | Values | Why |
|---|---|---|
| `half` | `container` \| `sessions` \| `both` | The exact distinction the recorded incidents turned on. |
| `scope` | `all` \| an absolute project path \| `container:<name>` | A one-project restart is not a stack restart, and one named container is not the container half. |
| `downtime` | `none` \| `brief` \| `full` | Whether the operator loses the running session, and for how long. |

`brief` means the thing comes back on its own. `full` means it stays down until
something else brings it up — which is why `tmux_stop` and `proj_stop` are
`full` and not `brief`: `CLAUDE.md` already warns that this family takes things
down and nothing returns them.

### The complete mapping

Every command in `scripts/admin-daemon.ts` that can take part of the system
down. Revised 2026-08-12 after the first implementation gated only three of
them — the original table named three commands and the gate covered exactly
those three, which is how an incomplete table becomes an incomplete control.

| Command | Line | Fingerprint | Gated |
|---|---|---|---|
| `bounce` | :424 | `sessions`/`all`/`brief` | yes |
| `host_restart` | :500 | `sessions`/`all`/`brief` | yes — the admin-daemon restart it also performs is invisible in the operator's tmux windows, so the operator-visible effect is a session bounce |
| `full_restart` | :538 | `both`/`all`/`full` | yes |
| `docker_restart` | :455 | `container`/`container:<name>`/`brief` | yes |
| `docker_restart_all` | :492 | `container`/`all`/`brief` | yes |
| `tmux_stop` | :391 | `sessions`/`all`/**`full`** | yes |
| `channel_kill` | :448 | `sessions`/`all`/`brief` | yes — Claude Code respawns the subprocesses |
| `proj_stop` | :678 | `sessions`/`<project path>`/**`full`** | yes |
| `stack_up` | :484 | — | **no**, by decision |
| `tmux_start` | :387 | — | **no**, by decision |
| `proj_start` | :397 | — | **no**, by decision |

**Why the last three are exempt, stated rather than left as a gap.** They only
bring things up. `stack_up` is idempotent by design and is the documented
recovery path when the stack is half-down; gating the command that repairs an
outage behind an approval the operator may be unable to give is the wrong shape.
An approval exists to stop something being taken away, and these take nothing
away. A command that ever gains a teardown step leaves this list.

An approval issued for one triple does not authorize another. "Да" to
`container/all/brief` cannot execute `sessions/all/brief` — which is precisely
the incident in `CLAUDE.md`.

### Data contract

[schemas/action-approval-grant.schema.json](schemas/action-approval-grant.schema.json):
`grantId`, the three fingerprint components, `issuedAt`, `expiresAt`,
`consumedAt`, `issuedBy` (a Telegram user id, or an actor plus the operator who
authorized it), `kind` (`operator` | `standing`), and the `requestId` it answers.

Rules the schema cannot express, stated here:

- A grant with `consumedAt` set is spent and cannot authorize anything.
- A grant past `expiresAt` is spent. Expiry is short — minutes — because a
  restart approval is answered immediately or not at all.
- Confirmation is two taps: the first creates an unconsumed grant and shows the
  sentence; the second presents it. `issuedAt` is the **first** tap — the moment
  the grant came into existence — and the unconsumed grant is itself the pending
  state, so no second "pending request" concept is needed.
- The executing code re-derives the fingerprint from the action it is *about to
  run* and compares. It never trusts a fingerprint carried alongside the
  request.
- No approver reachable → `deny`, except for an actor holding a standing grant
  (below). A restart triggered by a watchdog does not proceed on the strength of
  a grant issued for something else.

### Standing grants for autonomous actors

**Correction, 2026-08-12.** This section first justified itself with a claim
that was false: that `scripts/tmux-watchdog.ts` already restarts wedged sessions
unattended, and that P-2.3 applied literally would therefore turn a recoverable
hang into an outage until morning. It does not and it would not. The original
watchdog **only alerts** — there is no restart in it, and the first
implementation of this area added one, on a trigger nobody specified, to
preserve a capability that never existed.

The trigger is withdrawn. helyx's unattended behaviour stays exactly as it was:
the watchdog alerts, and a human decides.

**The mechanism stays**, because P-2.3 still needs an answer for the day an
autonomous actor does exist, and because the answer should be designed before
there is pressure to ship one. A standing grant is:

- scoped to a single fingerprint, `sessions`/`<project path>`/`brief` for a
  per-project session actor;
- **not consumed** by use — the one exemption from P-2.2 in this package, and
  what the word "standing" means;
- bounded by narrowness rather than by expiry: a `container`, a `both`, or an
  `all`-scoped action from a standing-grant holder is denied like any other
  unapproved action;
- declared, with the actor and the operator who authorized it both recorded;
- recorded on every use as an autonomous action.

Today **no actor holds one**. `scripts/grant-watchdog-standing.ts` can issue one
by hand, and nothing in the running system does. That is the intended state: a
mechanism that is specified, tested and unused is cheap; a capability that
appeared because a document was wrong is not.

| Property | Ordinary grant | Standing grant |
|---|---|---|
| `consumedAt` semantics | spent on first use | not consumed; the grant persists |
| `expiresAt` | minutes | absent or long; revoked rather than expired |
| `issuedBy` | a Telegram user id | the actor id, plus the operator who authorized the standing grant |
| Scope | whatever was approved | narrow by construction; widening is an operator decision |
| Recorded | as an approval | as an **autonomous action**, so the morning shows what restarted itself and on whose authority |

This is the only exemption from P-2.2 in the package, and it is bounded by being
narrow rather than by being temporary.

### Integration points

| Point | File | Change |
|---|---|---|
| Restart entry | `scripts/admin-daemon.ts` — every command in the mapping table marked gated | Derive the fingerprint; require a matching unspent grant; then take the lease where one is taken. Note that only `bounce`, `host_restart` and `full_restart` take a lease at all; the other five are gated without one, because approval and mutual exclusion are different questions. |
| The unleased path | `cli.ts`, the `"bounce"` switch branch | `CLAUDE.md` names this as the path that bypasses the lease. It must either take the same gate or refuse when another restart is in flight. |
| Buttons | `bot/commands/system.ts`, `bot/commands/prepare-restart.ts`, `bot/commands/supervisor-actions.ts` | The confirmation states the fingerprint in words before asking, so "да" has a referent. |
| Callback | `utils/callback-route.ts`, `bot/callbacks.ts` | The grant id travels; the action does not travel in the callback data. |

### Acceptance criteria

| # | Criterion |
|---|---|
| A2.1 | A grant issued for `container/all/brief` is refused when presented for `sessions/all/brief`, and the refusal names both. |
| A2.2 | A grant is single-use: the second presentation is refused. |
| A2.3 | An expired grant is refused. |
| A2.4 | A restart requested with no approver reachable is denied, not allowed. |
| A2.5 | The lease is still taken; a second concurrent restart is still refused with who holds it and for how long. |
| A2.6 | The confirmation text names the half, the scope and the downtime before the operator answers. |
| A2.7 | `bun cli.ts bounce` no longer races a Telegram-triggered restart silently. |
| A2.8 | The watchdog restarts a wedged session of a project it holds a standing grant for, unattended, and the action is recorded as autonomous. |
| A2.9 | The same watchdog is refused a `container`, a `both`, and an `all`-scoped restart. |
| A2.10 | A standing grant is not consumed by use; an operator grant is. |

---

## A1 — Scanning the boundary with the external world

### The boundary, and what is deliberately outside it

**The operator channel is never scanned.** A message between the operator and a
session — a `reply`, a typed instruction, a permission prompt — stays inside the
trust boundary and passes through no gate. The operator's own conversation with
their own project on their own machine is not a threat surface, and a control
placed there would spend its failures on the one channel that must work.

Version 1.0.0 of this package put the scan exactly there. That was wrong, and
the reason it was wrong is worth recording: keryx had running code for an
outbound reply scan, and availability of a solution was allowed to stand in for
the presence of a risk.

**The boundary that does exist** is where helyx content leaves for a service the
operator does not control, and where content from such a service comes back.
Five such crossings exist today, none of them scanned:

| # | Crossing | Direction | Code | What crosses |
|---|---|---|---|---|
| E1 | Groq / Yandex Cloud / OpenAI speech synthesis | out | `utils/tts.ts:307` (Yandex), `:329` (Groq), `:356` (OpenAI) | The full text of a reply, whenever the configured voice is not local `piper`. |
| E2 | Groq transcription | out | `utils/transcribe.ts:46` | The operator's raw voice audio. |
| E3 | Auxiliary LLM | both | `utils/aux-llm-client.ts:28` (DeepSeek), `:34` (OpenRouter) | Prompts, summaries, curator input — and whatever comes back. |
| E4 | Reviewer models | both | `services/reviewer-service.ts` via the provider layer | The git diff of the operator's project, and the report returned. |
| E5 | Session provider | both | `services/provider-service.ts`, `claude/client.ts` | Whatever a session sends to a non-local provider. |

E1 and E2 are the two that change the picture most, because they run on the
*conversational* path without being *of* it: the operator says nothing to a third
party, and their voice and the agent's words go to one anyway. Scanning there is
not scanning the conversation — it is scanning what leaves for Yandex.

The inbound halves of E3, E4 and E5 are the prompt-injection surface: a reviewer
report or an auxiliary-model answer is untrusted text that gets fed back into a
session, which is exactly the shape keryx's `untrusted-external` source kind
exists for.

### Verified behaviour of the keryx side

Probed directly on 2026-08-12 against the installed `keryx` v0.2.16. These are
measurements, not readings of documentation, and two of them change the design:

| Probe | Result |
|---|---|
| `keryx security check-output` with clean input | `gate: PASS`, `action: allow`, `findings: 0` |
| With `AKIAIOSFODNN7EXAMPLE` | `gate: FAIL`, `action: block`, one `secrets.aws-access-key` finding, `severity: critical`, `confidence: 0.98` |
| **Exit code when blocking** | **`0`** — in all three modes: bare, `--json`, and `--runtime claude` |
| `--target telegram` | Silently accepted; the finding records `"target": "unknown"` |
| `--target external` | Registers correctly: `"target": "external"` |
| `--target nonsense` | Silently accepted, no error |
| Output on block | Includes a `Redacted` section carrying the redacted form of the payload |

**The exit code is the trap.** `keryx security check-output` exits `0` even when
its verdict is `block`. An integration written as
`if keryx security check-output …; then send; fi` is a control that never fires
and looks like it is working. The integration **must** parse `--json` and branch
on `gate` and `action`; the exit code carries no verdict.

**The target is `external`, not `telegram`.** An unrecognised `--target` degrades
to `unknown` rather than refusing, so a typo produces a scan whose findings are
mis-attributed and whose policy may differ, with nothing on stderr to say so.
helyx passes `external` and asserts in a test that the returned finding's
`target` field reads back `external`.

### Data contract

The scanner's verdict, as helyx consumes it:

| Field | Values | Meaning for helyx |
|---|---|---|
| `gate` | `pass` \| `needs-approval` \| `fail` | The overall verdict. |
| `action` | `allow` \| `redact` \| `block` \| `require-approval` \| `warn` | What helyx does with the message. |
| `findings[].category` | `secret` \| `pii` \| `prompt-injection` \| `egress` \| … | What kind of thing was found. |
| `findings[].severity` | `critical` \| `high` \| `medium` \| `low` \| `info` | Ranking for the operator's review surface. |
| `findings[].redactedPreview` | string | **Not shown to the operator on a block** — see R1.3. Stored for the review surface only. |
| `findings[].hash` | sha256 | Stable identity of a finding across repeats. |
| `findings[].remediation` | string | Safe to show; contains no payload. |

### Mapping verdict to behaviour

The governing rule: **a finding must never cost the operator a message.** Every
crossing has somewhere to fall back to, and the fallback is preferred to a
refusal in every case where one exists.

| `action` | Outbound crossing (E1–E5) | Inbound crossing (E3–E5) |
|---|---|---|
| `allow` | Send. | Accept. |
| `warn` | Send; record. | Accept; record. |
| `redact` | Send the redacted form. | Accept the redacted form. |
| `require-approval` | Downgrade per the row below; do not hold a conversational path waiting for a human. | Treat as `redact`. |
| `block` | **Do not cross. Use the local fallback**: E1 → synthesise with local `piper`; E3/E4/E5 → refuse *that* external call and say so where it was invoked; E2 → no local fallback exists, so the transcription is refused and the operator is told, once. | Do not feed the content into a session; surface the refusal at the call site. |
| scan failed | Treat as `block`, with the same fallbacks. A failed scan costs a voice that is synthesised locally instead of remotely, or one reviewer that does not run. It never costs a reply. |

This is what makes the fail-closed question from version 1.0.0 disappear rather
than get answered. Fail-closed here means "the answer is spoken by piper instead
of Yandex" and "one reviewer is skipped" — not "the bot goes silent".

### Integration points

| Point | File | Change |
|---|---|---|
| E1 remote TTS | `utils/tts.ts:307`, `:329`, `:356` | Scan the text immediately before the remote call. On a finding, fall through to local `piper` (`:8-9`) and record why. |
| E2 transcription | `utils/transcribe.ts:46` | Scan is not applicable to raw audio; what is enforced here is a **posture check**, not a content scan: remote transcription is an explicit opt-in, and its state is visible. See §A1 posture below. |
| E3 auxiliary LLM | `utils/aux-llm-client.ts:28`, `:34` | Scan the outbound prompt; scan the returned completion as `untrusted-external` before it reaches a session or memory. Skipped entirely when the base URL is the local Ollama (`:31`). |
| E4 reviewer models | `services/reviewer-service.ts`, `scripts/review.ts` | Scan the diff before it is sent; scan the returned report before it is fed back. |
| E5 session provider | `services/provider-service.ts`, `claude/client.ts` | Scan applies only when the configured provider is not local. Anthropic-direct is still external. |
| Review surface | `mcp/dashboard-api.ts` | Where findings are listed. |
| **Operator channel** | `channel/tools.ts:376`, `mcp/tools.ts:380` | **No change. Explicitly out of scope.** A test asserts that no scan is invoked on this path, so that a later well-meaning change cannot quietly add one. |

### Posture, not only content

Two of the five crossings are decided by configuration rather than by payload,
and for those the control is a visible posture rather than a scan:

- Remote TTS and remote transcription are **opt-in**, and which one is active is
  reported by an existing status surface. A local-only install should be able to
  prove it is local-only without reading `.env`.
- The default remains whatever is configured today; this package changes
  visibility, not the operator's choice.

### Config shape

Declared by
[schemas/external-boundary-policy.schema.json](schemas/external-boundary-policy.schema.json).
Defaults: scanning on for every crossing, local fallback preferred over refusal,
operator channel permanently excluded and not configurable.

### Acceptance criteria

| # | Criterion |
|---|---|
| A1.1 | **The operator channel is not scanned.** A test asserts that `reply` on both `channel/tools.ts` and `mcp/tools.ts` invokes no scanner, and fails if one is ever added. |
| A1.2 | A reply containing an AWS-key-shaped string is still delivered to Telegram, unchanged — the same test, from the other side. |
| A1.3 | That same reply, when the configured voice is remote, is synthesised by local `piper` instead, and the substitution is recorded. |
| A1.4 | A git diff containing a key-shaped string is not sent to a third-party reviewer model; the reviewer is skipped and the skip is reported. |
| A1.5 | A reviewer report or auxiliary-model completion containing an injection pattern is not fed into a session unredacted. |
| A1.6 | The local Ollama base URL (`utils/aux-llm-client.ts:31`) skips scanning entirely — a local call is not a crossing. |
| A1.7 | Killing or renaming the `keryx` binary causes remote crossings to fall back or be skipped, and never causes a reply to be withheld. |
| A1.8 | A test asserts the verdict is read from parsed `--json` output; a test fails if the implementation branches on the process exit code. |
| A1.9 | A test asserts the finding's `target` reads back `external`. |
| A1.10 | Whether remote TTS and remote transcription are active is visible from a status surface without reading `.env`. |
| A1.11 | Added latency is measured on the crossings only; the operator path is unmeasured because it is untouched (M1). |

---

## A3 — Session archive and the compaction record

### What exists today

Claude Code writes a `compact_boundary` entry into its own transcript naming what
was dropped and how long compaction took. Nothing in helyx reads it — recorded in
project memory and unchanged as of this package. `utils/context-usage.ts` tracks
window pressure; `channel/status.ts` renders session state; neither consumes the
boundary entry.

### What is adopted

The **split**, not the store. keryx keeps `context.jsonl` (the model window a
resume loads) beside `archive.jsonl` (the full audit log, which survives
`/compact`), and its compactor raises `EvidenceDeletionError` rather than
allowing an entry to vanish. History is append-only and content-addressed;
entries are deep-frozen.

helyx does not own its sessions' windows — Claude Code does. What helyx owns is
what it keeps beside them. So:

- **Read the boundary.** Parse `compact_boundary` from the transcript; record
  that a compaction happened, at what time, and what it named.
- **Surface it.** The operator learns that the session forgot something at the
  moment it happens, not by inferring it from an answer that has lost its
  context.
- **Never shorten the archive.** Whatever helyx already persists of a session is
  append-only from that point. A summarisation step may add a summary; it may
  not replace what it summarised.

### Integration points

| Point | File | Change |
|---|---|---|
| Transcript read | `utils/subagent-transcripts.ts`, `channel/status.ts` | Recognise the `compact_boundary` entry type. |
| Operator surface | `channel/status.ts`, `utils/status-render.ts` | A compaction is an event worth one line. |
| Context accounting | `utils/context-usage.ts` | A window that just shrank by compaction is not the same signal as a window filling up. |

### Acceptance criteria

| # | Criterion |
|---|---|
| A3.1 | A session that compacts produces an operator-visible record naming when and what. |
| A3.2 | A fixture transcript containing a `compact_boundary` entry is parsed without error. |
| A3.3 | A transcript with no boundary entry behaves exactly as today. |
| A3.4 | No code path rewrites or deletes an already-recorded helyx-side session entry; a test asserts the refusal. |

---

## A4 — Engine connector (delta to `codex-session-engine-2026-08-09`)

### What this adds

The related package is
[codex-session-engine-2026-08-09](../codex-session-engine-2026-08-09/README.md),
with its open questions listed in
[review-focus.md](../codex-session-engine-2026-08-09/review-focus.md). It
establishes the problem, the tmux invariant, the MCP wiring
question, and the limit-detection asymmetry. It does not have a *name* for the
thing it is adding, so it repeats the definition instead of declaring it. This
area supplies the name and the registry entry, and nothing else. Where the two
disagree, the codex package wins on anything about Codex; this one wins only on
vocabulary and credential handling.

### The distinction, adopted verbatim from keryx

> A connector is NOT a provider: a provider gives keryx a raw model stream; a
> connector delegates the agentic loop to an external tool (Claude Code, Codex)
> while keryx supplies project context, approval routing, and the metaproject
> layer.

In helyx terms: `provider_id`/`model` configure a **provider**; `engine`
selects a **connector**. They are orthogonal axes, which is what the codex
package already says in prose.

### Registry entry

[schemas/engine-connector-entry.schema.json](schemas/engine-connector-entry.schema.json),
adapted from keryx's `connector-entry.schema.json`: `id`, `displayName`,
`launch` (command and argv), `transport` (`stdio` | `mcp`), `identity` (how the
project reaches the process — for helyx today, the `X-Helyx-Project` header
built from `HELYX_PROJECT_PATH`), `credential` (which file the vendor's client
owns, always read-only), `resume` (the engine's own continuity command, e.g.
`codex resume --last`), and `limitSignal` (how "this engine hit its usage limit"
is detected, `null` where there is none).

`limitSignal: null` is the honest encoding of the asymmetry the codex package
flags as R1: `noteApiError()` reads a shape specific to Claude Code's transcript,
and Codex has no transcript in that format.

Today `scripts/run-cli.sh:159` launches one binary unconditionally. The registry
turns that line into data.

### Credential decisions

Adopted from keryx C-03, C-04, C-05, restated as helyx rules in
[policies.md](policies.md) §P-3 and §P-4. In short: read-only, no refresh,
delegate expiry to the vendor's client, and state the compliance boundary at
activation.

### The finding that changes the codex spike

keryx's C-03 records a path helyx has not considered: read
`tokens.access_token` from `~/.codex/auth.json` and call the OpenAI Chat
Completions API directly as a Bearer credential. That would make Codex an
ordinary streaming provider — no `codex exec`, and therefore not blocked by the
self-executing-tools problem recorded in project memory as the reason the codex
provider spike stalled.

This package does **not** recommend it. It records three things and hands the
decision back:

1. It exists and it is the model OpenCode uses.
2. keryx itself files it under a compliance boundary (D-01) that permits driving
   the vendor's own client and is silent-to-negative on replaying its token. The
   cost of getting that wrong falls on the operator's own subscription.
3. It answers a different question than `codex-session-engine` asks. That
   package wants Codex *as itself* — its own tool loop, its own session. A
   Chat Completions bearer gives a model, not an agent.

### Acceptance criteria

| # | Criterion |
|---|---|
| A4.1 | `codex-session-engine-2026-08-09` can adopt the terms `provider` and `connector` without contradicting anything it already states. |
| A4.2 | The schema expresses every engine attribute that package needs, including `limitSignal: null`. |
| A4.3 | The credential rules are stated as helyx policy, not as a description of keryx. |
| A4.4 | The Chat Completions finding is recorded with its boundary attached, and is not presented as a recommendation. |

---

## A5 — Telegram perimeter

### What already holds

Two of keryx's four perimeter rules are **already implemented in helyx**. This
was checked against the code rather than assumed, and it changes the shape of
the area: A5 is smaller than it looked.

| Rule | Where it already holds |
|---|---|
| Authorization is per sender; membership of a room grants nothing | `bot/access.ts:19` checks `CONFIG.ALLOWED_USERS` per `ctx.from.id`; anything else is dropped, with the bot's own id excluded from the warning (`:30`). |
| An unmapped topic is a refusal, never a fallback | `bot/text-handler.ts:178-184` answers "⚠️ Топик не привязан ни к одному проекту" and routes nowhere. The General topic is refused separately at `:81-84`. Most pointedly, the typed-answer path at `:96-106` returns `{ kind: "unresolved" }` rather than "no scope", with a comment stating the reason: without the project, "a message typed in one topic could answer a question waiting in another". |

Both are recorded as **regression pins**, not as work. A later refactor must not
be able to lose either without a test failing.

### What does not hold

| Rule | Today |
|---|---|
| A secret never travels through Telegram | A provider key is typed into a chat (`bot/commands/providers.ts`), which puts it in Telegram's servers and in the message history permanently. |
| An approval callback is opaque, expiring, single-use | `perm:allow:${requestId}` (`utils/permission-render.ts:46-48`) is a readable prefix plus an id, with no expiry of its own; safety rests entirely on the pending row having been deleted. |
| The off-switch is understood | `CONFIG.ALLOW_ALL_USERS` (`bot/access.ts:15`) disables per-sender authorization with one flag, and nothing says so at runtime. |
| Outbound degrades silently on a missing topic | Inbound refuses; outbound does not. `channel/tools.ts:397-404` resolves `forum_topic_id` per reply and, finding none, clears `isForumReply` and sends without a `message_thread_id` — so a reply for a project whose topic mapping is gone lands in the forum's General topic instead of refusing. The asymmetry is small but it is the one direction where a message goes somewhere unintended. |

### Changes

- **R5.1 pin, plus the outbound half.** The inbound refusal is pinned by test.
  The outbound path is brought into line: a reply whose project has no topic
  mapping is a stated failure, not a General-topic send.
- **R5.2 handoff.** Setting a secret emits a one-time, expiring local link; the
  value is entered outside Telegram and stored where helyx already keeps
  secrets. Telegram carries the link, never the value. The existing
  `utils/hook-token.ts` establishes the pattern of a secret living in a shared
  local file that neither side has to type.
- **R5.3 callbacks.** Approval callbacks carry an opaque single-use token with
  its own expiry, resolved server-side to the pending action. This is the same
  mechanism A2 needs for grants; build it once.
- **R5.4 the flag.** Document what `ALLOW_ALL_USERS` is for, log loudly at
  startup when it is on, and decide whether it may combine with a forum
  deployment.

### Acceptance criteria

| # | Criterion |
|---|---|
| A5.1 | *(pin)* A message in a topic mapped to no project produces a refusal in that topic and reaches no session — already true; a test fails if it stops being true. |
| A5.2 | *(pin)* Supergroup membership alone authorizes nothing — already true via `bot/access.ts`; a test fails if it stops being true. |
| A5.3 | A reply for a project with no topic mapping is a stated failure, not a General-topic send. |
| A5.4 | No code path accepts a secret value from a Telegram message body. |
| A5.5 | A replayed approval callback is refused; an expired one is refused. |
| A5.6 | Starting with `ALLOW_ALL_USERS` on emits a warning naming the consequence. |

---

## Cross-area integration

Two dependencies exist and are the only ones:

- **A1 → A2.** The scanner emits `require-approval`. Until A2 exists, A1 treats
  it as `block`. A1 does not wait for A2; it downgrades.
- **R5.3 → A2.** The opaque single-use expiring token is one mechanism serving
  both approval grants and approval callbacks. Whichever area lands first builds
  it; the second uses it. (`R5.3` is the requirement in [prd.md](prd.md); the
  acceptance criterion that closes it is `A5.5` above.)

Everything else is independent. A3 touches nothing A1, A2, A4 or A5 touch.

## Roadmap

`docs/requirements/roadmap.md` is updated with this package as a standard-level
capability under `draft`, with no delivery date, since no area is scheduled.
