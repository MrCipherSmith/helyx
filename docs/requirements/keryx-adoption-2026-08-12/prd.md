# PRD: Adopting keryx Patterns into helyx

Version: 1.1.0

## Problem

helyx has grown five gaps that keryx has already closed, or has already written
down how to close. In each case helyx knows about the gap — three of them are
documented in `CLAUDE.md` or in an existing requirements package — and in each
case the reason nothing was built is that the shape of the answer was unclear,
not that the problem was disputed.

The five, stated as the failure each one permits today:

**P1 — Nothing guards the boundary with the external world.** helyx content
leaves for services the operator does not control in five places, and content
comes back from three of them, and none of the five is inspected:

| # | Crossing | Code | What crosses |
|---|---|---|---|
| E1 | Yandex Cloud / Groq / OpenAI speech synthesis | `utils/tts.ts:307`, `:329`, `:356` | The full text of a reply, whenever the configured voice is not local `piper`. |
| E2 | Groq transcription | `utils/transcribe.ts:46` | The operator's raw voice audio. |
| E3 | DeepSeek / OpenRouter auxiliary LLM | `utils/aux-llm-client.ts:28`, `:34` | Prompts, summaries, curator input — and whatever returns. |
| E4 | Reviewer models | `services/reviewer-service.ts`, `scripts/review.ts` | The git diff of the operator's project, and the report returned. |
| E5 | Non-local session provider | `services/provider-service.ts`, `claude/client.ts` | Whatever a session sends out. |

E1 and E2 are the uncomfortable pair. They sit on the conversational path
without being part of the conversation: the operator addresses no third party,
and their voice and the agent's words go to one anyway, decided by a
configuration value most operators would have to read `.env` to discover.

The inbound halves of E3, E4 and E5 are a prompt-injection surface. A reviewer
report is untrusted text authored by a third-party model and fed straight back
into a session.

helyx already runs `keryx security check-input` on the operator's own prompt —
this session's prompt was scanned — while a diff of the operator's project
travels to DeepSeek unexamined. The asymmetry is the wrong way round.

**What P1 is not.** It is not a gate on the operator's conversation with their
own sessions. Version 1.0.0 of this package put one there — a scan on `reply`,
fail-closed, on the single channel between the operator and their work. That was
wrong on the merits: the operator receiving their own secret from their own
machine is not an exfiltration, and the control would have spent its failures,
its false positives and its latency on the one path that must never fail. It is
recorded rather than deleted because the reason it got written matters — keryx
had running code for exactly that scan, and the availability of a solution was
allowed to stand in for the presence of a risk.

**P2 — An approval is not bound to what it approved.** `CLAUDE.md` records the
incident twice: an agent asked "перезапускаю?", got "да", and restarted the half
of the system the operator was not asking about, leaving the other half dead
with nothing saying so. The existing defence, `claimRestart`
(`scripts/admin-daemon.ts:342`), is a *mutex*: it stops two restarts from racing.
It cannot stop one restart from being the wrong restart, because nothing ties the
operator's "да" to a specific action. The same weakness has a second face in the
permission surface: `perm:always:${requestId}`
(`utils/permission-render.ts:47`) grants a class of action indefinitely from one
button press.

**P3 — Compaction is a silent amnesia.** Claude Code writes a `compact_boundary`
entry naming exactly what it dropped and how long it took. helyx reads it
nowhere. When a long session compacts, the operator's transcript, the status
line, and any later summary are all built from a window that has quietly lost
its early half, and nothing in the product says so.

**P4 — "Engine" and "provider" are the same word in two places.**
`codex-session-engine-2026-08-09` states that "a provider and an engine are
orthogonal: `provider_id`/`model` only mean anything when `engine = 'claude'`"
and then has to keep re-explaining the distinction, because helyx has no name
for the second thing. Without a name there is no registry entry, no schema, and
no place to record how the second engine is launched, how it is reached, and
what happens when its credential expires.

**P5 — Three holes around two controls that are already right.** Checking
before writing changed this one. helyx already authorizes **per sender**
(`bot/access.ts:19`) and already **refuses an unmapped topic** rather than
falling back to another project (`bot/text-handler.ts:178-184`, and the
typed-answer path at `:96-106` which returns `unresolved` precisely so that one
topic cannot consume another's question). Those are keryx's two central
perimeter rules and helyx implements both.

What is left is genuinely left: `CONFIG.ALLOW_ALL_USERS` turns per-sender
authorization off with one flag and says nothing at runtime; a callback is a
plaintext prefix plus an id (`utils/permission-render.ts:46-48`) with no expiry
of its own; a provider secret is typed into a Telegram chat, which puts it in
Telegram's servers and in the message history permanently; and the outbound path
does not match the inbound one — `channel/tools.ts:397-404` sends to the forum's
General topic when a project's topic mapping is missing, where the inbound path
would have refused.

## Goal

Turn each of the five into a decided, specified, reviewable change, with the
evidence grade of the source stated, so that a later flow can pick up any one of
them and implement it without re-doing this analysis — and so that the two areas
whose keryx source is only a specification are not mistaken for proven designs.

## Users

| User | Interest |
|---|---|
| The operator (single, via Telegram) | Not having a secret published; not having the wrong half of the stack restarted; knowing when the session forgot something. |
| A future implementing agent | A specification precise enough to build from, with the code it must touch already cited. |
| A reviewer | Being able to tell which claims rest on running code and which rest on a document. |

## Evidence Grades

Every area carries a grade for its keryx source. This is the single most
load-bearing distinction in the package, because keryx's requirements
directories contain more finished-looking specification than keryx contains
implementation.

| Grade | Meaning |
|---|---|
| `code` | keryx ships it, it runs, and it is reachable from the keryx CLI. |
| `code-partial` | keryx ships the mechanism, but not on the path helyx would use it from. |
| `spec` | A keryx requirements document. Nothing runs. Its status line says so. |

| Area | Grade | Basis |
|---|---|---|
| A1 external-boundary scan | `code` | `keryx security check-output` is in `keryx security --help`; `src/security/redact.ts`, `harness-scan.ts` exist; the input half already runs against helyx. The *scoping* of A1 to the five crossings is helyx's own analysis, not keryx's — keryx has no equivalent of E1/E2. |
| A2 fingerprint-bound approval | `code` | `src/harness/policy/engine.ts` (9.5K) with `engine.test.ts` (21K) and `profiles.test.ts` (26K); the four properties are stated in `docs/docs/harness.md`. |
| A3 archive/context split | `code` | `src/session/store.ts` (26.6K), `compact.ts`; `EvidenceDeletionError` is documented behaviour. |
| A4 connector abstraction | `spec` | `keryx-agent-connectors/README.md` states "No connector is implemented today." |
| A5 Telegram perimeter | `spec` | `keryx-telegram-transport/README.md` states "No Telegram integration is claimed to be implemented." |

A `spec` grade is not a reason to reject an area. A4 and A5 are the two areas
where keryx has thought further than helyx *because* it had to write it down
before building. It is a reason to treat their content as argument rather than
as evidence, and to require helyx's own spike before implementation.

## Requirements

### A1 — Scanning the boundary with the external world

- **R1.1** *(the governing exclusion)* **The operator channel is never
  scanned.** No message between the operator and a session — `reply`, typed
  instruction, permission prompt — passes through any gate introduced by this
  area. This is enforced by a test that fails if a scan is ever added there, and
  it is not configurable.
- **R1.2** Each of the five crossings E1–E5 is scanned in the directions that
  carry content: outbound for what leaves, inbound for what a third-party
  service returns before it reaches a session or memory.
- **R1.3** **A finding never costs the operator a message.** Every crossing
  declares a local fallback or a skip: E1 falls back to local `piper`; E3, E4
  and E5 skip that external call and report the skip where it was invoked; E2
  has no local alternative and is refused with the operator told once.
- **R1.4** A scan that cannot complete takes the same path as a blocking
  finding. Because no operator path is a crossing, "fail closed" here costs a
  locally-synthesised voice or a skipped reviewer — never a withheld reply.
- **R1.5** A local call is not a crossing. The local Ollama base URL
  (`utils/aux-llm-client.ts:31`) and local `piper` are exempt by construction,
  not by configuration.
- **R1.6** Which remote services are active is visible from a status surface
  without reading `.env`. Remote transcription and remote synthesis are the two
  cases where the risk is decided by configuration rather than by payload, so
  for those the control is visibility, not a gate.
- **R1.7** Findings are recorded where the operator can review them without
  reading logs.
- **R1.8** Latency is measured on the crossings. The operator path is not
  measured because it is not touched. See
  [metrics-and-validation.md](metrics-and-validation.md) §M1.

### A2 — Approval bound to an action

- **R2.1** An approval authorizes exactly one action, identified by a
  fingerprint over the action's meaning — for a restart, which half of the
  system it touches and which project. A grant that does not match the action
  presented at execution time is not a grant.
- **R2.2** A grant is single-use and is spent when consumed.
- **R2.3** An `ask` with no live approver resolves to `deny`, never to `allow`.
  This is the rule that makes an unattended restart safe by construction.
- **R2.4** A hard `deny` is terminal: no approval, role, or retry flips it.
  `flow.json` remains an example of a target nothing may write through this
  path.
- **R2.5** The restart family is the first and only adopter in scope:
  `bounce`, `host_restart`, `full_restart`, and the CLI's own
  `bun cli.ts bounce`, which `CLAUDE.md` records as the one path that bypasses
  the lease entirely.
- **R2.6** The existing lease is kept. A fingerprint gate answers "is this the
  action that was approved"; the lease answers "is another restart already
  running". They are different questions and both must be asked.
- **R2.7** Reworking `perm:always:` into a bounded grant is **out of scope**
  here and recorded as a follow-up, because it touches the permission flow on
  every tool call rather than a family of five commands.

### A3 — Session archive and the compaction record

- **R3.1** helyx reads Claude Code's `compact_boundary` entry and surfaces that
  a compaction happened, when, and what it named as dropped.
- **R3.2** The operator-visible transcript is built from a record that
  compaction does not shorten. helyx does not control Claude Code's own window;
  it controls what it keeps beside it.
- **R3.3** An entry that has been recorded is never rewritten or deleted by a
  later summarisation step. keryx raises `EvidenceDeletionError` rather than
  allowing it; helyx needs the equivalent refusal, whatever it is named.
- **R3.4** Adopting keryx's session store wholesale is **not** required. helyx's
  sessions are Claude Code's, not keryx's; what is adopted is the split — a
  window that may shrink, an archive that may not.

### A4 — Engine connector, as a delta to codex-session-engine

- **R4.1** helyx adopts the vocabulary: a **provider** supplies a raw model
  stream; a **connector** delegates the agentic loop to an external agent
  process while helyx supplies context, identity and approval routing. The
  existing `engine` axis in `codex-session-engine-2026-08-09` is a connector
  registry in all but name.
- **R4.2** A connector entry is declared data, not a branch in a shell script:
  launch command, transport (`stdio` | `mcp`), and how project identity reaches
  it. Today `scripts/run-cli.sh:159` launches exactly one binary
  unconditionally.
- **R4.3** Credential files belonging to another vendor's client
  (`~/.claude/.credentials.json`, `~/.codex/auth.json`) are **read-only** to
  helyx. helyx never writes, modifies, or creates them.
- **R4.4** helyx does not implement token refresh for a subscription
  credential. On expiry it surfaces an authorization error and points the
  operator at the originating client (`claude login`, `codex --login`). The
  cost — a long session can fail mid-run on authorization — is accepted and
  stated, because a second refresher introduces races with the official client
  and a second place a credential can leak from.
- **R4.5** The compliance boundary in [policies.md](policies.md) §P-4 is
  restated at the point where a connector is activated, not buried in a
  document.
- **R4.6** This package does not choose between helyx's `codex exec` path and
  keryx's read-the-credential path. It records that the second exists, that it
  changes the Phase 0 spike question recorded in project memory, and that it
  sits nearer the compliance boundary than driving the vendor's own binary
  does. The choice belongs to the codex package.

### A5 — Telegram perimeter

- **R5.1** *(pin + one gap)* A topic that maps to no project is a **refusal**,
  never a fallback. This already holds inbound and is pinned by test. The
  outbound path is brought into line: a reply for a project with no topic
  mapping is a stated failure rather than a silent send to the General topic.
- **R5.2** A secret never travels through Telegram. Setting a provider key uses
  a one-time local handoff, so the value is never in a Telegram message, in
  Telegram's servers, or in the chat history.
- **R5.3** An approval callback is opaque, expiring and single-use. Today
  `perm:allow:${requestId}` is a readable prefix plus an id, and its safety
  depends entirely on the pending row having been deleted.
- **R5.4** `CONFIG.ALLOW_ALL_USERS` is re-examined: what it is for, whether it
  can be reached by accident, and whether it should refuse to combine with a
  forum deployment. Per-sender authorization is only as good as the flag that
  turns it off.
- **R5.5** *(pin)* Membership of an authorized supergroup grants nothing on its
  own. This already holds in `bot/access.ts` and is recorded so that a later
  change cannot lose it silently.

## Success criteria

| # | Criterion |
|---|---|
| S1 | Each area has a stated decision, an evidence grade, and cited code on both sides. |
| S2 | A reader can tell, per area, whether keryx's version runs or is a document — without opening keryx. |
| S3 | No area claims helyx behaviour that does not exist; every "today" statement carries a `file:line`. |
| S4 | A5's requirements distinguish what already holds (per-sender auth) from what does not, so no work is done twice. |
| S5 | A4 adds only what `codex-session-engine-2026-08-09` lacks and contradicts nothing in it. |
| S6 | Each area can be picked up independently; none blocks another. |

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| A `spec`-grade source reads as a proven design and is implemented unquestioned. | A5 or A4 ships a shape keryx itself never validated. | Evidence grades on every area; both marked `spec`; both require a helyx spike before implementation. |
| A1's scanner produces false positives on ordinary developer output — a diff containing a token-shaped string is exactly what E4 sends. | A reviewer is skipped for no reason, repeatedly, and the operator disables the control. | M1.3 measures the rate against a real corpus of diffs and reports before enabling; a noisy rule becomes a recorded exception, never a disabled scanner. |
| A1 creeps back onto the operator channel — a later change adds "just a warning" to `reply`. | The control this package explicitly rejected returns by increment. | R1.1 is enforced by a test that fails when a scan appears on either reply path, not by a comment. |
| A1's local fallbacks are treated as optional and a crossing is simply refused instead. | A finding costs the operator a spoken answer, which is the failure mode this design exists to avoid. | R1.3 names the fallback per crossing; the schema requires `localFallback` to be stated or explicitly null. |
| A2's fingerprint is defined so narrowly that ordinary restarts constantly re-ask. | Approval fatigue, which ends in blanket approval — the failure it was built to prevent. | The fingerprint is over the *half of the system touched* and the project, not over the command string. |
| A2 is implemented as a second lease and quietly re-solves the wrong problem. | The original incident remains possible. | R2.6 states the two questions separately; M2 tests the wrong-half case specifically. |
| A4's credential-reading path is taken because it is easier, and lands outside the compliance boundary. | The operator's own subscription is at risk, and the cost falls on their account. | P-4 states the boundary; R4.6 hands the choice to the codex package rather than defaulting to it. |
| Five areas in one package become five half-done things. | Nothing lands. | The implementation plan sequences them and states that A2 alone is a complete, shippable outcome. |
| keryx moves; these citations rot. | The package quietly describes a keryx that no longer exists. | Every citation carries the commit (`af380a6a`, v0.2.16). |

## Recommendation

Adopt all five as recorded decisions; implement in the order
**A2 → A1 → A3 → A5 → A4**.

A2 first, because the incident it prevents has already happened twice, is
recorded in `CLAUDE.md` as having happened twice, and its cost to the operator
is one sentence of confirmation text that names what is about to be restarted.
It buys real protection and takes nothing away.

A1 second. It was first in version 1.0.0 and was demoted for cause: as written
then it gated the operator's own channel, which is not a threat surface. Rescoped
to the five external crossings it is worth doing — a project diff going to
DeepSeek is a genuine egress and skipping one reviewer costs nothing
conversational — but it is a larger, five-call-site change than A2, and the
crossings it guards are opt-in paths rather than daily ones.

A4 last despite being the most interesting, because it is `spec`-graded on both
sides — a keryx document meeting a helyx draft — and because implementing it
before `codex-session-engine-2026-08-09` has chosen its path would be choosing
that path by accident.
