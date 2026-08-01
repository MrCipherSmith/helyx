# security

Version: 0.1.0

## Purpose

Policy-based scanning, redaction, guardrails, and audit reports for project
artifacts, external content, agent outputs, and orchestrated flows. Enforcement
is guaranteed only where `keryx` controls the workflow; elsewhere the
module provides agent-facing rules, validation commands, and advisory reports.

Ownership boundary: this module owns the agent/artifact boundary (prompts,
external text, tool output, writes to memory/wiki/reports/task context, prompt
injection, exfiltration, redaction, incident trail). Dependency vulnerabilities
and committed-secret history stay with the `security-audit` skill.

## Agent Entry

- Read this manifest before claiming security status or gate results.
- Prefer the curated report `data/security/artifacts/latest.md`.
- Treat findings as signals; verify against source before acting.

## Commands

- `keryx security status`
- `keryx security scan <path> [--json] [--source <kind>]`
- `keryx security check-input [--source <kind>] [--file <path>]`
- `keryx security check-output [--target <kind>] [--file <path>]`
- `keryx security redact <path> [--out <path>]`
- `keryx security report [--since <ref>] [--json]`
- `keryx security policy validate`
- `keryx security incidents [--limit <n>]`

## Config

- `security.config.json` (mode, raw retention, policies, backends, gate,
  `configChecksum`).

## Hooks

Both hooks are optional, offered at `init` only when security is enabled,
merge-safe (managed blocks that never clobber user content), idempotent, and
refreshed by `update` without touching `data/security`.

- Git pre-push gate (`.git/hooks/pre-push`, opt out with `--no-security-hook`):
  runs `keryx security scan` over the changed/committable content. Blocking
  follows `security.config.json` `mode`: `advisory` (default) warns and allows
  the push; `enforced`/`ci` block the push (non-zero exit) on a secret/critical
  finding. Installed as a `# keryx:security-pre-push` managed block that
  coexists with the testing pre-push block and any user-authored hook content.
- Agent guard (`.claude/settings.json`, opt out with `--no-security-agent-hook`):
  adds `UserPromptSubmit` → `keryx security check-input` and
  `PreToolUse`(Write|Edit) → `keryx security check-output`. Merged under a
  `_keryxManaged: ["security-agent-hooks"]` sentinel so all pre-existing keys
  and user hook entries are preserved and uninstall removes only managed entries.

## Data

- `data/security/artifacts/` - committable `latest.md` / `latest.json`
  (masked previews, categories, severities, actions - never raw secrets).
- `data/security/incidents/` - incident trail.
- `data/security/redactions/` - redacted samples.
- `data/security/policies/` - policy snapshots.
- `data/security/raw/` - local-only: HMAC key, self-protect state, local hash
  report. Never committed (gitignored).

## Capabilities

- `security.secrets`
- `security.pii`
- `security.prompt-injection`
- `security.egress-control`

## Generated Artifacts

- `data/security/artifacts/latest.md` and `latest.json` on `scan` / `report`.
- Committable artifacts contain no hashes of secrets or PII; keyed HMAC hashes,
  when kept, live only in local-only reports under `data/security/raw/`.

## Lifecycle

- `init` scaffolds config, data folders, and this manifest (optional module,
  opt out with `--no-security`).
- `update` refreshes service files (this manifest, core README, config if
  missing) without touching `data/security`.
- Raw retention defaults to `off`; the module operates without persisting raw
  content. A `configChecksum` mismatch or a mode downgrade is always surfaced
  as a finding plus an incident entry (self-protection, specification.md §14).
