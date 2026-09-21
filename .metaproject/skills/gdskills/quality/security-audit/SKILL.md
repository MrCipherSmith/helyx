---
name: security-audit
description: "Use when checking for dependency vulnerabilities, accidentally committed secrets, or security issues in Docker images. NOT for Metaproject security policy — prompt-injection, redaction and memory/wiki/report writes belong to `metaproject-security` — and NOT for performing the upgrades a finding calls for (use `dependency-update`)."
triggers:
  - "security audit"
  - "audit dependencies"
  - "scan secrets"
  - "Security scan"
  - "Check for CVEs"
  - "npm audit"
  - "bun audit"
  - "Dependency vulnerabilities"
metadata:
  author: "MrCipherSmith"
  version: "1.1.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Security Audit

## Purpose

Comprehensive security audit covering dependency vulnerabilities, secrets in code/git history, and container image scanning. Produces a prioritized remediation report.

**Input:** None (scans current project)
**Output:** Severity-grouped vulnerability report with remediation steps

## When to Use

- Before a release
- After adding new dependencies
- Periodic security review

## Steps

### Step 1 — Dependency vulnerabilities

Detect from the **lockfile**, not from an installed binary. The lockfile is what
an audit reads; `bun` being on PATH says nothing about whether `bun audit` has a
lockfile to resolve.

| Lockfile present (repo root) | Command |
|---|---|
| `bun.lock` **or** `bun.lockb` | `bun audit --json` |
| `package-lock.json` **or** `npm-shrinkwrap.json` | `npm audit --json` |
| `pnpm-lock.yaml` | `pnpm audit --json` |
| `yarn.lock` | `yarn npm audit --json` (Yarn 2+), else `yarn audit --json` (Yarn 1) |

Check **both** Bun names — `bun.lock` and `bun.lockb`. Bun 1.2 replaced the
binary `bun.lockb` with the text `bun.lock`, so a project on current Bun has
only `bun.lock`, and a `bun.lockb`-only check (`bun.lock` unmatched) finds
nothing there.

**If no row matches, the dependency audit DID NOT RUN.** Say so:

```
dependency-audit: NOT RUN — no recognised lockfile in <path>
```

and carry `not measured` — never `0` — into every severity total in the report.
Do not fall through to another package manager's audit as a guess.

**A command that could not produce results is also NOT RUN.** `npm audit --json`
without a lockfile exits 1 and prints roughly 240 bytes of
`{"error":{"code":"ENOLOCK",...}}` — an object with **no `vulnerabilities` key
at all**. Grouping that by severity yields zero for critical, high, moderate and
low, which is indistinguishable from a clean project. So before grouping, check
that the payload actually carries vulnerability data (`vulnerabilities` /
`advisories` for npm, the per-package arrays for bun). If it does not, the
outcome is NOT RUN with the tool's own error, not a clean result.

Only once a command has produced real vulnerability data:

Group by severity: **critical → high → moderate → low**

### Step 2 — Outdated packages
Run `outdated` for the package manager Step 1 detected (`bun outdated`,
`npm outdated`, `pnpm outdated`, `yarn outdated`). Flag packages more than 2
major versions behind. If Step 1 found no package manager, this step is
`NOT RUN` for the same reason.

### Step 3 — Secrets scan
- Check git history for `.env`, `.key`, `.pem` files
- Grep source for hardcoded passwords/API keys/secrets (excluding node_modules)

### Step 4 — Docker image scan
If a Dockerfile is present and Docker is available: `docker scout cves`.
Otherwise report `container-scan: NOT RUN — <no Dockerfile | docker unavailable>`.
"No Dockerfile" and "scanned, nothing found" are different results.

### Report
- Per step: `RAN` or `NOT RUN — <reason>`. A step that did not run has no totals.
- Total by severity, for the steps that ran
- Top 3 critical/high with CVE
- Recommended immediate actions
- Packages safe to ignore (dev-only, not reachable in prod)

## Rules

- Distinguish prod vs dev-only vulnerabilities
- Never suggest `npm audit fix --force` without explaining what it changes
- **A check that did not run is not a check that passed.** Never report a
  severity total — least of all zero — for a step whose command was not
  selected, could not run, or returned no vulnerability data. Report `not
  measured` and name the reason. In a security report, silence read as "clean"
  is the most expensive defect available.

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "The advisory is informational / low severity — ship it" | This skill reports severity, it does not filter it. Accepting a known CVE is the caller's decision to make explicitly, not one you make for them by omission |
| "`npm audit` returned JSON with no vulnerabilities in it, so the project is clean" | Check for the `vulnerabilities` / `advisories` key before grouping. `ENOLOCK` is ~240 bytes of error that groups to zero in every severity — indistinguishable from clean, and that is the whole point of Step 1 |
| "No lockfile row matched, but `npm audit` is the usual one" | Falling through to another package manager's audit is a guess dressed as a result. The outcome is `dependency-audit: NOT RUN — no recognised lockfile`, with no totals attached |
| "There's no Dockerfile, so container scan: 0 issues" | "No Dockerfile" and "scanned, found nothing" are different results and only one of them is evidence. Report `container-scan: NOT RUN — no Dockerfile` |
| "`npm audit fix --force` clears the whole list" | `--force` installs semver-major upgrades across the tree. Never recommend it without stating which packages it would move and by how much |
| "That key looks like a test fixture, not a real secret" | A committed credential gets reported with its path and rotated first; whether it was live is decided afterwards, by someone who can check. Never print its value in the report |

## Verification

Do not report the audit as done until all of the following hold:

- Every step carries `RAN` or `NOT RUN — <reason>`, and no step marked NOT RUN carries a numeric total
- Severity totals appear only for steps that ran; everywhere else the report reads `not measured`, never `0`
- Every critical/high entry names a CVE or advisory id, the package, and the version range that pulls it in
- No raw secret value appears anywhere in the report — only path, line, and a redacted preview
- The report names the package manager and lockfile detected in Step 1, so a reader can tell which tree was audited
