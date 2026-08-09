# PRD — Codex Provider for Claude Code

Version: 1.1.0

## Problem

When the operator's Claude usage limit is hit mid-session, a project's
interactive session has no fallback model. Flow 061 already tells the
difference between a limit and a hang and holds the queue until the limit
resets, but it does not use the Codex CLI capacity the operator already pays
for and has already authenticated in helyx (`bot/commands/codex.ts`,
`/codex_setup`) — today that login only drives one-shot code reviews
(`services/reviewer-service.ts`), never the operator's actual working
session.

Separately: helyx already lets a project pick a non-Anthropic backend
(GLM, Kimi, DeepSeek, OpenRouter, and — once `OLLAMA_PROXY_ENABLED` is on —
the local Ollama model) from `/providers`, all while the tmux window keeps
running the same `claude` binary. Codex cannot be added to that list the
same way DeepSeek was, because OpenAI exposes no endpoint that speaks
Anthropic's Messages API and Codex's auth is an OAuth session tied to a
ChatGPT subscription, not a bearer token `resolve-provider-env.ts` can
export. Getting Codex into the same picker requires a translator in front
of it, the way `ollama-proxy.ts` is a translator in front of Ollama.

## Goal

Add "Codex" as a provider option a project can select from `/providers`,
exactly like DeepSeek or the local model, so the operator can move a
project's session onto the Codex subscription without changing what runs in
its tmux window — still `claude`, still helyx-channel, still the same
session the operator has been talking to. "The same Claude Code, just
talking to OpenAI [through Codex]," as put when this package was
commissioned.

## Users

The operator (single user, controls this host and this Telegram bot),
acting through `/providers` and, once configured, through the normal
Claude Code conversation in a project's tmux window.

## Requirements

- **FR1 — Provider option.** A `codex` entry in
  `bot/providers/presets.ts`, selectable the same way existing presets are,
  and a `providers` row it seeds (no schema change — the table already
  supports an arbitrary `base_url`/`auth_scheme`/`models` combination).
- **FR2 — Local translator.** A host-side daemon, sibling to
  `scripts/ollama-proxy.ts`, exposing Anthropic `POST /v1/messages` on
  loopback, that turns each call into a Codex invocation authenticated
  through the login `/codex_setup` already performed — no second
  credential, no token entry in the `/providers` add-flow beyond a
  placeholder the daemon ignores.
- **FR3 — Blast radius stays local.** No writes to `~/.claude/settings.json`
  or any other Claude Code global configuration, ever — inherited unchanged
  from `docs/requirements/ollama-provider-2026-08-07`.
- **FR4 — Legible failure.** A Codex quota exhaustion or an expired login
  must reach the operator as a named condition (the way
  `run-cli.sh`'s existing provider-hint does for a bad DeepSeek/GLM token),
  not a bare connection error. Reuse `classifyCodexFailure()` from
  `services/reviewer-service.ts` rather than re-deriving the same
  error-string parsing at the proxy layer.
- **FR5 — Tool-call fidelity — not met, superseded.** The original ask was
  that tool calls Claude Code issues during a turn resolve exactly once, by
  Claude Code's own tool implementations, never duplicated or pre-empted by
  Codex acting through its own sandboxed tools. The 2026-08-09 spike
  answered this negatively — see **Recommendation**. FR5 as written cannot
  be met with `codex exec`'s current CLI surface; `specification.md`
  §"Option A" is the fallback, and whether its reduced fidelity is worth
  shipping is the operator's decision, not assumed here.

## Success Criteria

A project configured with the Codex provider holds a real coding
conversation through the ordinary Claude Code UI and helyx-channel path;
tool calls happen exactly once; a spent Codex quota produces the same kind
of actionable Telegram message the existing providers give for a bad token,
not a hang or an opaque error; nothing outside that project's own launch
changes.

## Risks

- **R1 — Codex is an agent, not a model backend (confirmed, blocking).**
  `codex exec` reads and can write files and runs shell commands itself,
  inside a sandbox policy it also controls (`-s read-only|workspace-write|
  danger-full-access`, verified against the installed `codex-cli 0.147.0`).
  Ollama's `/api/chat`, by contrast, only ever returns a decision — Claude
  Code's own tool loop does the acting. The 2026-08-09 spike
  ([spike-findings.md](spike-findings.md)) confirmed there is no
  `codex exec` mode that returns tool-call intent *without* Codex having
  already executed something (reads) or reduced the intent to unstructured
  prose (a write blocked by the sandbox). FR5 does not hold; Option B in
  `specification.md` is ruled out. This is why the package stays `draft`
  rather than moving to `spec ready` for the reduced design.
- **R2 — Subscription-use judgment call.** This design spawns helyx's own
  already-authenticated official `codex` binary, so it carries none of the
  copyright risk of a leaked-source project and none of the OAuth-reuse
  risk of a third-party proxy that reimplements ChatGPT login (both
  evaluated the same session and rejected for those reasons). It is not
  free of risk, though: a ChatGPT-subscription entitlement is priced and
  offered for use through OpenAI's own client, and driving it continuously
  as a silent backend for a different product is a terms-of-use question,
  not an engineering one. This should be the operator's explicit call, not
  an assumption buried in an implementation.
- **R3 — Per-turn latency.** Each `codex exec` call is a fresh process
  start (`npx`/`codex` invocation), not a request against a warm, already
  running model server. Interactive turn latency could be materially worse
  than Ollama or a hosted API. `--ephemeral` avoids on-disk session
  buildup but not the spawn cost.
- **R4 — Blast-radius regression.** The exact failure mode that burned this
  host on 2026-08-07 (a proxy or router that ends up touching global Claude
  Code configuration) must not recur. Carried into `specification.md`'s
  acceptance criteria as a checked item, not a stated intention.
- **R5 — Stale model default.** `services/reviewer-service.ts`'s
  `CODEX_MODEL` currently defaults to `"o3"`. Whatever model id this
  provider's preset offers must be checked against the operator's actual
  Codex entitlement before it appears in a menu the operator picks from —
  copying the reviewer's default without checking it would ship a
  known-possibly-stale value.

## Recommendation

**Spike run 2026-08-09 — see [spike-findings.md](spike-findings.md).**
Three real `codex exec --json -s read-only` calls against a throwaway
scratch directory answered the question this section originally posed:
Codex always acts first and narrates after (or, for a blocked write,
narrates an *intent* as unstructured prose rather than a parseable
decision). FR5 does not hold with the CLI surface available today.

That leaves `specification.md` §"Option A" as the only remaining design:
Codex runs the whole turn as a delegated sub-agent (sandboxed
`workspace-write`, per the operator's risk tolerance from R2), and its
final text becomes the assistant's reply with no real `tool_use`
translation. This is not "the same tool loop, different backend" — it is
Codex doing its own thing under Claude Code's face — and building it
should be a decision the operator makes with that difference stated
plainly, not a silent substitution. Per the operator's own instruction when
the spike was commissioned, nothing beyond the spike has been built; this
package stays at `draft` until that decision is made.
