# Policies: Adopting keryx Patterns into helyx

Version: 1.2.0

## Purpose

The rules this package introduces, written as sentences that can be enforced and
tested. A rule that cannot be checked is a preference; those are in
[prd.md](prd.md) instead.

Each rule states its own **failure mode** — what goes wrong when it is absent —
because a policy whose cost is not stated gets removed by the first person who
finds it inconvenient.

---

## P-1 — The external boundary

### P-1.0 The operator channel is not a boundary — it is inside one

**No control in this package inspects, gates, delays or withholds a message
between the operator and a session.** Not `reply`, not a typed instruction, not
a permission prompt. The operator reading their own secret, from their own
machine, on their own project, is not an exfiltration; placing a gate there
spends the control's failures and false positives on the one channel that must
never fail.

This rule outranks every other rule in P-1. Where any other rule could be read
as reaching the operator channel, this one wins.

*Failure mode of getting this wrong:* the operator, facing a bot that has gone
silent at an inconvenient moment, disables the scanner entirely — and it stays
disabled. A control with no legitimate cost is kept; a control that taxes the
daily path is removed at the first bad moment, along with the parts that were
earning their keep.

### P-1.1 Every crossing is scanned

The five crossings E1–E5 in [specification.md](specification.md) §A1 are scanned
in the directions that carry content: outbound for what leaves helyx, inbound
for what a third-party service returns before it reaches a session or memory.

A crossing added later — a new remote service, a new provider — is scanned or is
recorded as an exception. Silent addition is the failure this rule prevents.

*Failure mode:* a diff of the operator's project reaches a third-party model
carrying a live key, and nobody knows until the key is used.

### P-1.2 A local call is not a crossing

Local `piper` synthesis and a local Ollama base URL are exempt by construction,
not by configuration. Nothing leaves the machine, so there is nothing to guard.

*Failure mode:* latency and false positives are paid on calls that never had a
risk, which discredits the control on the calls that did.

### P-1.3 A finding never costs the operator a message

Every crossing declares what happens instead: E1 falls back to local `piper`;
E3, E4 and E5 skip that external call and report the skip at the site where it
was invoked; E2 has no local alternative, so it is refused and the operator is
told once.

*Failure mode:* the control is experienced as "the assistant stopped answering",
which is P-1.0's failure arriving through the side door.

### P-1.4 A failed scan takes the same path as a finding

If the scanner cannot run, cannot be found, or returns output helyx cannot
parse, the crossing is not made. There is no degraded mode in which a crossing
proceeds unscanned.

This is affordable precisely because of P-1.3: fail-closed here means a voice
synthesised locally instead of remotely, or one reviewer skipped. It never means
a withheld reply.

*Failure mode:* the control appears present, has been silently absent since a
path changed, and nobody learns this until after a leak.

### P-1.5 The verdict is read from the verdict, never from the exit code

`keryx security check-output` exits `0` even when its verdict is `block`
(verified 2026-08-12, v0.2.16, in all of bare, `--json` and `--runtime` modes).
helyx parses `--json` and branches on `gate` and `action`.

*Failure mode:* `if check-output; then cross; fi` — a control that never fires and
looks like it works.

### P-1.6 A refusal reveals nothing

When a crossing is refused, what is reported at the call site says that it was
refused and why in general terms. It does **not** carry a preview, a redacted
preview, a hash, a character offset, or the finding's category where that
category would narrow the content. keryx's rule, adopted as written: a blocked payload must not be
partially reconstructable from its own refusal.

*Failure mode:* the refusal becomes an oracle, and a determined reader
reconstructs the secret from a series of them.

### P-1.7 Scan before the call, not after

The scan runs before the payload is handed to the remote service, before it is
chunked, and before any preview is written to a log. A redaction applied after
the HTTPS call has already leaked.

*Failure mode:* the reply is synthesised locally as intended, and the same text
was already posted to Yandex to find that out.

### P-1.8 The target is `external`

Crossing content is scanned with `--target external`. keryx's
valid targets are `model`, `memory`, `wiki`, `report`, `external`, `task`,
`unknown`; an unrecognised value is silently accepted and recorded as `unknown`
rather than refused.

*Failure mode:* `--target telegram` looks correct, is accepted, and scans under
the wrong policy with nothing on stderr to say so.

---

## P-2 — Approval

### P-2.1 An approval names its action

An approval authorizes exactly one action, identified by a fingerprint over what
the operator would notice: which half of the system is touched, which project,
and what downtime results. An approval that does not match the action about to
run is not an approval.

*Failure mode:* the one recorded twice in `CLAUDE.md` — "перезапускаю?", "да",
and the wrong half restarts while the other stays down with nothing saying so.

**Every command that can take part of the system down is gated**, not only the
ones that happen to take the restart lease. The complete list, and the three
bring-up commands exempted with a stated reason, are in
[specification.md](specification.md) §A2 "The complete mapping". A control that
covers three of eight entrances is a control over three entrances.

### P-2.2 A grant is spent once

A grant carries `consumedAt` and a short `expiresAt`. Either one set means the
grant authorizes nothing further.

*Failure mode:* one "да" authorizes a second restart minutes later that the
operator never saw coming.

### P-2.3 No approver means deny

An action requiring approval, with no live approver reachable, resolves to
`deny`. It never resolves to `allow`, and it never waits indefinitely holding a
lease.

*Failure mode:* an unattended watchdog restart proceeds on the strength of a
grant issued for something else, at the hour nobody is watching.

### P-2.3a An autonomous actor carries a standing grant, or it does nothing

**Corrected 2026-08-12.** This rule was first written to protect an existing
capability: `scripts/tmux-watchdog.ts` restarting a wedged session at 4am. That
capability did not exist — the watchdog only alerts, and it still only alerts.
The rule stands anyway, because it answers what happens *if* an autonomous actor
is ever added, and that answer is better decided now than under pressure.

An autonomous actor may act unattended only while holding a **standing grant
scoped to exactly the fingerprint it is allowed to act on**. Inside that
fingerprint it acts without asking. Outside it, P-2.3 applies unchanged and it
is denied.

Three properties make this a grant rather than a loophole:

- It is **declared**, not implicit: the actor, the fingerprint, and the operator
  who authorized it are recorded like any other grant.
- It is **not single-use** — the one property of P-2.2 it is exempt from, and
  the exemption is what "standing" means — but it is **narrow**, and a widening
  is an operator decision, not a code change.
- Every use is **recorded as an autonomous action**, so the operator can see in
  the morning that something acted on its own and on what authority.

**No actor holds one today, and adding one is a decision, not an implementation
detail.** A change that grants an actor unattended power is not covered by
having built this mechanism.

*Failure mode:* the standing grant is scoped to `all`, or to `both`, and its
holder acquires the ability to restart the whole stack unattended — a larger
power than any single human approval in this system grants.

### P-2.4 A deny is terminal

A hard `deny` is not overridable by an approval, a retry, a different transport,
or an operator role. `flow.json` remains a target nothing writes through an
approval path; that rule predates this package and is restated, not introduced.

*Failure mode:* the deny list becomes advisory, and the first urgent exception
makes it permanently so.

### P-2.5 The fingerprint is re-derived, never carried

The executing code computes the fingerprint from the action it is **about to
run** and compares it to the grant. It never trusts a fingerprint that travelled
alongside the request.

*Failure mode:* the fingerprint describes what was intended rather than what is
about to happen, and the check passes on a lie.

### P-2.6 The lease stays

The fingerprint gate answers "is this the action that was approved". The lease
answers "is another restart already running". Both questions are asked; neither
replaces the other.

*Failure mode:* the new gate is mistaken for a replacement, the lease is removed,
and two restarts tear down what the other just built.

---

## P-3 — Credentials belonging to another client

### P-3.1 Vendor credential files are read-only

`~/.claude/.credentials.json`, `~/.codex/auth.json` and any equivalent are
**read-only inputs**. helyx never writes to them, modifies them, creates them, or
moves them.

*Failure mode:* replacing a refresh token corrupts the official client's state,
and the operator loses the login helyx depends on.

### P-3.2 helyx does not refresh a subscription token

On expiry, helyx surfaces an authorization error and points the operator at the
originating client (`claude login`, `codex --login`). It does not mint new access
tokens from a refresh token.

*Accepted cost, stated:* a long-running session can fail on authorization
mid-run. This is preferred to a second refresher, which introduces races with the
official client and a second surface a credential can leak from.

### P-3.3 A credential is never logged, echoed, or sent

A token read under P-3.1 exists in memory for the request that uses it. It does
not appear in a log line, a status message, a Telegram reply, a dashboard field,
or an error trace.

---

## P-4 — The compliance boundary

Inherited from keryx decision **D-01**
(`docs/requirements/keryx-provider-auth/decisions.md`) and restated so that
helyx owns it rather than references it.

### P-4.1 What is permitted

**Driving the vendor's own client as a subprocess.** Claude Code and Codex hold
their own credentials; helyx supplies project context, identity, and approval
routing, and orchestrates. This is what helyx does today, and keryx names helyx
by URL as the reference for it.

Device-code authorization (RFC 8628) for providers whose terms sanction
third-party clients — GitHub Copilot is the documented case.

### P-4.2 What is not

Extracting or replaying subscription OAuth tokens where the vendor's terms
forbid third-party use. Anthropic's Consumer Terms cover Claude Pro/Max
(enforcement from January 2026, policy from April 2026); OpenAI reserves ChatGPT
sign-in for Codex. The cost of ignoring this falls on the operator's own account,
which is the operator's subscription, not an abstraction.

### P-4.3 The boundary is stated where it is crossed

A connector that reads a vendor credential states this boundary **at the point
of activation** — in the command that enables it — not only in a document. A
boundary nobody is shown at the moment of the decision is a boundary that exists
only in review.

### P-4.4 One operator, one subscription, one machine

No proxying, no pooling, no multi-tenant routing of anyone's credential. A
connector serves a single operator's own session.

---

## P-5 — Perimeter

### P-5.1 Authorization is per sender

Membership of a chat, group, or supergroup authorizes nothing on its own. Every
sender is authorized individually. *Already holds* (`bot/access.ts:19`); pinned
so it cannot be lost.

### P-5.2 An unmapped topic is a refusal

A topic that maps to no project produces a stated refusal in that topic. It never
routes to another project's session and never to a default. *Already holds
inbound* (`bot/text-handler.ts:178-184`, `:96-106`); pinned.

The **outbound** direction must match: a reply for a project with no topic
mapping is a stated failure, not a send to the forum's General topic.

*Failure mode of the outbound gap:* a project's answer appears in General, where
it is both out of place and, if the mapping was lost rather than never made,
unattributed.

### P-5.3 A secret never travels through Telegram

Setting a secret uses a one-time, expiring local handoff. Telegram carries the
link; it never carries the value.

*Failure mode:* the key is in Telegram's servers and in the operator's message
history permanently, recoverable by anyone who later gains access to either.

### P-5.4 An approval callback is opaque, expiring and single-use

Callback data resolves server-side to a pending action. It does not encode the
action, and its safety does not rest on a row having been deleted.

### P-5.5 The off-switch announces itself

`ALLOW_ALL_USERS`, and any future flag that disables an authorization control,
logs a warning at startup naming what it turns off and what that permits.

*Failure mode:* the flag is set once for a debugging session and never noticed
again.

---

## Precedence

**P-1.0 outranks everything.** No rule in this document authorizes a gate on the
operator's conversation with their own sessions. If a rule can be read as
reaching that channel, the reading is wrong.

Below it, where two rules could both apply, the order is: **P-4 (compliance) >
P-1 (external boundary) > P-2 (approval) > P-3 (credential handling) > P-5
(perimeter)**.

An action that P-4 forbids is not made permissible by an approval under P-2. A
crossing P-1 refuses is not made because P-5 authorized the sender.
