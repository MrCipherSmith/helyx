---
name: review-security-code
model_tier: standard
description: "Use when a code-level security review is requested, checking for injection vulnerabilities, auth gaps, insecure cryptography, secrets, and OWASP Top 10 patterns in changed code. NOT for infrastructure, deployment, or dependency audits."
triggers:
  - "security review"
  - "проверь безопасность"
  - "безопасность кода"
  - "secure code"
  - "vulnerability"
  - "check for vulnerabilities"
  - "security check"
  - "OWASP review"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "review"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Review: Security Code (Code-Level Vulnerabilities)

## Purpose

Finds exploitable security vulnerabilities introduced in the changed code of the current branch. Covers injection, auth/authz gaps, IDOR, secrets, insecure crypto, CSRF, path traversal, and framework-specific patterns (NestJS, React). Produces findings with explicit attack vectors and concrete fixes.

This skill covers **code-level security only**. It does NOT audit npm/bun dependency trees, Docker configurations, or deployment surfaces — use `security-audit` for those.

---

## Input Contract

| Field | Required | Description |
|-------|----------|-------------|
| Branch / diff range | No | Defaults to merge-base..HEAD + uncommitted changes |
| Explicit commit hash/range | No | Review only that range when provided |
| `JOB_NAME` | No | Job name when dispatched by orchestrator |
| `CONTEXT_PATH` | No | Path to context doc when dispatched by orchestrator |

---

## Scope Boundaries

| Concern | This skill | Use instead |
|---------|-----------|-------------|
| Injection (SQL, XSS, command, SSTI) | YES | — |
| Auth/authz gaps, IDOR, privilege escalation | YES | — |
| Missing input validation / DTO validation | YES | — |
| Hardcoded secrets, logging secrets | YES | — |
| Insecure cryptography (MD5, SHA1, weak random) | YES | — |
| CSRF, path traversal, open redirect | YES | — |
| OWASP Top 10 code patterns | YES | — |
| NestJS-specific: missing guards, unvalidated DTOs | YES | — |
| React-specific: dangerouslySetInnerHTML, eval() | YES | — |
| npm/bun dependency vulnerabilities | NO | `security-audit` |
| Infrastructure / Docker / deployment security | NO | `security-audit` |
| Performance bottlenecks | NO | `review-performance` |
| Logic correctness, architecture | NO | `review-logic`, `review-architecture` |
| Code style, naming | NO | `code-style-review` |

---

## Scope Detection

See shared script: `.metaproject/skills/gdskills/shared/git-merge-base.md`

Run the script from that file to determine `MERGE_BASE` (`BASE_SHA`) and `SCOPE` before proceeding.

### Commands to collect the review slice

```bash
git status
git log --oneline "${BASE_SHA}..HEAD"
git diff --stat --name-status "${BASE_SHA}..HEAD"
git diff "${BASE_SHA}..HEAD"

# Include uncommitted changes (default mode):
git diff --stat --name-status "${BASE_SHA}"
git diff "${BASE_SHA}"
git ls-files --others --exclude-standard
```

For explicit hash/range mode:

```bash
git diff --stat --name-status <FROM_SHA>..<TO_SHA>
git diff <FROM_SHA>..<TO_SHA>
```

---

## Review Checklist

Work through every category below for each changed file. Tie every finding to a concrete line in the diff.

### 1. Injection Vulnerabilities

**SQL Injection**
- [ ] Raw SQL built by string concatenation or template literals with user input
- [ ] ORM `query()` / `rawQuery()` calls with unparameterized values
- [ ] TypeORM `createQueryBuilder` using `.where(\`field = '${value}'\`)` instead of parameterized bindings

Attack vector template: _"Attacker sends `' OR '1'='1` as `<param>`, bypassing WHERE clause."_

**XSS (Cross-Site Scripting)**
- [ ] React `dangerouslySetInnerHTML` with unsanitized user content
- [ ] Template engines rendering user data without escaping
- [ ] Server-side HTML construction with string concatenation

Attack vector template: _"Attacker injects `<script>document.cookie</script>` via `<param>`."_

**Command Injection**
- [ ] `child_process.exec()` / `execSync()` with user-supplied arguments
- [ ] Shell string building: `exec(\`ls ${userInput}\`)`
- [ ] Prefer `execFile()` / `spawn()` with argument arrays

Attack vector template: _"Attacker passes `; rm -rf /` as `<param>`, executed in shell context."_

**Server-Side Template Injection (SSTI)**
- [ ] Template engine `render()` called with user-controlled template string (not just data)
- [ ] Dynamic template loading from user-supplied names without allowlist

**`eval()` / `Function()` / `vm.runInNewContext()`**
- [ ] Any usage with non-literal, non-compile-time strings

### 2. Authentication and Authorization

**Missing Authentication Guards**
- [ ] NestJS: controllers or routes missing `@UseGuards(JwtAuthGuard)` (or equivalent)
- [ ] Express: middleware chain missing auth check before sensitive handler
- [ ] GraphQL resolvers missing `@UseGuards` decorator

**Missing Authorization / RBAC**
- [ ] NestJS: routes with data-mutating operations missing `@Roles()` / `@Permissions()`
- [ ] Guard present but role check is overly permissive (e.g., allows any authenticated user for admin action)

**Broken Auth Logic**
- [ ] JWT verification disabled or bypassed (`verify: false`, `algorithms: []`)
- [ ] Session fixation: session ID not rotated on privilege elevation
- [ ] Password comparison with `==` instead of `crypto.timingSafeEqual` or bcrypt

**Privilege Escalation**
- [ ] User can change their own `role`, `permissions`, or `isAdmin` via a user-facing update endpoint
- [ ] User ID taken from request body instead of authenticated session/token

### 3. Insecure Direct Object References (IDOR)

- [ ] DB lookup by `id` taken from request params/body without verifying ownership: `repo.findOne({ id: req.params.id })` — no `userId` scope check
- [ ] File access, download, or deletion by filename/path from request without ownership validation

Attack vector template: _"Attacker replaces `id=123` with `id=456` in request, accessing another user's resource."_

### 4. Missing Input Validation / Sanitization

- [ ] NestJS: DTO class without `class-validator` decorators (`@IsString()`, `@IsEmail()`, `@IsUUID()`, etc.)
- [ ] NestJS: `ValidationPipe` not applied globally or per-handler
- [ ] Express: no `express-validator` or equivalent on body/query params
- [ ] Accepting unbounded `limit`/`offset` from user without max cap (DoS vector)
- [ ] File upload: MIME type and extension validated only client-side, not server-side
- [ ] Email/URL fields accepted without format validation

### 5. Secrets and Credentials

- [ ] Hardcoded API keys, passwords, tokens, or private keys in source
- [ ] Secrets passed via URL query params (end up in logs and proxies)
- [ ] Passwords, tokens, or PII logged via `console.log`, `logger.debug`, or error serialization
- [ ] `.env` files committed to version control
- [ ] JWT secret is a short literal string (`"secret"`, `"myapp"`)

### 6. Insecure Cryptography

- [ ] MD5 or SHA1 used for password hashing or security tokens
- [ ] `Math.random()` used to generate tokens, nonces, or session IDs — use `crypto.randomBytes()`
- [ ] AES-ECB mode (deterministic, leaks patterns) — prefer AES-GCM
- [ ] RSA with key size < 2048 bits
- [ ] Hardcoded IV/salt instead of random per-operation

### 7. CSRF

- [ ] State-changing endpoints (POST/PUT/PATCH/DELETE) accessible from browser context without CSRF token validation
- [ ] CSRF protection middleware bypassed for specific routes
- [ ] SameSite cookie attribute absent or set to `None` without `Secure`

### 8. Path Traversal

- [ ] File path constructed from user input without normalization and allowlist check: `fs.readFile('./uploads/' + filename)`
- [ ] `path.join()` used but result not validated against base directory (join can escape with `..`)
- [ ] Correct pattern: `path.resolve(BASE, filename)` followed by check that result starts with `BASE`

Attack vector template: _"Attacker sends `filename=../../etc/passwd`, reading arbitrary server files."_

### 9. Open Redirect

- [ ] Redirect target taken from user-supplied query param without allowlist: `res.redirect(req.query.returnTo)`
- [ ] Only relative paths or allowlisted origins should be accepted as redirect targets

### 10. React-Specific Patterns

- [ ] `dangerouslySetInnerHTML={{ __html: userContent }}` without DOMPurify or equivalent sanitization
- [ ] `eval(userInput)` or `new Function(userInput)` in component or hook
- [ ] Sensitive data stored in `localStorage` / `sessionStorage` (XSS accessible)
- [ ] `postMessage` handler without origin check

### 11. NestJS-Specific Patterns

- [ ] Controller method lacks `@UseGuards` when the route handles sensitive data or mutations
- [ ] DTO class lacks `class-validator` annotations; `ValidationPipe` has `whitelist: false` or `forbidNonWhitelisted: false`
- [ ] `@Body() body: any` — accepting untyped, unvalidated body
- [ ] `@Public()` decorator used on an endpoint that should require auth
- [ ] File upload handler missing MIME-type and size validation

---

## Iron Laws

### Shared laws (every reviewer)

1. **A claim of runtime harm with no reproducible path is `info`.** If you cannot
   name the input, call, or condition that reaches the code, you have an
   observation, not a finding. Report it as `info` and say what would settle it.
2. **Never flag the theoretical.** The path you describe must exist in the code
   under review. Do not report a safe API because it could be misused, or a
   pattern because it is often wrong elsewhere.
3. **One finding per class, not one per occurrence.** When the same shape appears
   at several sites, report it once and list every site. Ten findings that are one
   finding hide the other nine problems.

Severity levels are defined once, in `review-orchestrator/SKILL.md` →
**Severity (canonical)**. This reviewer does not restate them: `blocker` is the
four merge-blocking shapes named there and nothing else, and the `major`/`minor`
boundary is the trigger-and-outcome test.

### Security-specific law

1. **Every security finding MUST state the attack vector explicitly.** Name the
   attacker action, the entry point, and the impact. No attack vector → no finding
   above `info`. This one does not generalise — a style reviewer has no attacker
   — so it stays here and only here.

---

## Output Contract

### Class scope — required for `blocker` and `major`

Every `blocker` and `major` finding must carry `class_scope`: **every** site that
holds the shape you found, and **how you enumerated them** — the grep or query
you ran, or the guard that derives the set.

A finding anchored to one `file:line` is a claim about one site. The recorded
history of this repository is that a fix then repairs that site and leaves its
siblings: one writer of five, one operator instruction of four, six readers of
eight. Each was found by the *next* review round, which is why reviews here have
run to seven and four rounds instead of one.

```yaml
class_scope:
  sites: ["src/lib/shell-config.ts:60", "src/session/store.ts:133"]
  enumeration_method: "grep for the config-path resolvers; 7 writers, 2 unguarded"
```

"I checked the others" is not an enumeration method. A single-entry `sites` list
is a claim that the class has exactly one member — make it deliberately, because
`review-finding.schema.json` accepts it and the next round tests it.

`minor` and `info` may omit it: enumerating the class for every low-severity
observation is theatre, not rigour.

### Status line (first line of response)

```
STATUS: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
```

- `DONE` — review complete, findings (if any) are below, no external info needed
- `DONE_WITH_CONCERNS` — review complete but one or more blockers or majors found
- `NEEDS_CONTEXT` — cannot determine whether code is vulnerable without additional context (e.g., missing route config, missing auth middleware file not in diff)
- `BLOCKED` — cannot run git commands or access the repo

### Report structure

```markdown
STATUS: DONE_WITH_CONCERNS

## Security Review

### Scope
- Branch: `<BRANCH>`
- Parent ref: `<PARENT>`
- Merge-base: `<BASE_SHA>`
- Scope mode: default-with-uncommitted | explicit-hash-range
- Changed files reviewed: <N>

### Summary
- Blockers: <N>
- Major: <N>
- Minor: <N>
- Info: <N>

### Findings

### [F-001] Title
- **Severity**: blocker | major | minor | info
- **File**: path/to/file.ts:line
- **Attack vector**: precise description of how an attacker exploits this
- **Problem**: what is wrong in the code
- **Why it matters**: concrete impact (data breach, account takeover, RCE, etc.)
- **Fix**: concrete suggestion
- **Patch** (optional):
```diff
- vulnerable line
+ fixed line
```

### Clean Areas
[List categories with no findings, confirming they were checked]
```

### Where security conditions land

Severity comes from **Severity (canonical)** in `review-orchestrator/SKILL.md`.
This reviewer keeps no table of its own; what follows is where its recurring
conditions land under that rubric, not a second rubric.

| Condition | Severity | Why, under the canonical rubric |
|---|---|---|
| Exploitable vulnerability in the current code path, with the attack vector stated | `blocker` | Named shape 3 |
| A real weakness whose exploitation needs a precondition the diff does not establish — an internal-only endpoint, an authenticated caller, a value not yet attacker-controlled | `major` | Trigger and outcome are named, but the path to exploitation is not complete |
| Hardening or defence-in-depth on code that is not currently exploitable | `minor` | The code behaves correctly; the cost is to whoever hardens it later |
| A pattern with no attack vector in the current code | `info` | Security-specific law, and shared law 1 |

**"Plausible attack scenario" is not a severity.** A scenario you can state and
reach is `blocker`; a scenario you can state but cannot reach is `major`; a
scenario you cannot state is `info`. Being the security reviewer does not raise
any of them — see the canonical rubric on severity being a property of the
outcome, not of the domain.

---

## Red Flags Table

Stop and re-read these rules if you are thinking:

| Rationalization | Why it's wrong |
|---|---|
| "It's probably behind auth so injection doesn't matter" | Auth is a separate layer; injection must be fixed at the data layer regardless |
| "The team would never send that payload" | Attackers are not on the team |
| "MD5 is used for caching keys, not passwords — it's fine" | State it as INFO, but do not silently skip it; it often drifts |
| "I'll downgrade to minor to avoid friction" | Severity reflects real risk, not social dynamics |
| "The code uses an ORM so SQL injection is not possible" | ORMs have raw-query escape hatches; verify parameterization |
| "No attack vector found — I'll call it major anyway" | No attack vector = `info` only, per the security-specific law |
| "It's a security finding, so it's a blocker" | `blocker` is the four shapes in **Severity (canonical)**. An unreachable weakness is `major` however alarming its name |
| "It's outside the diff but the pattern is clearly wrong" | Only flag changed code; flag legacy via INFO with note to track separately |

---

## Job Context Awareness

When dispatched by `job-orchestrator` or `review-orchestrator` as part of a job pipeline, the prompt MAY include:

```
JOB_NAME:     <job-name>
CONTEXT_PATH: <JOBS_ROOT>/<job-name>/ai/context.md
```

If provided and the file exists, read the context document before starting the review. Use it to:
- Understand which auth framework is in use (custom JWT, Passport, Keycloak, etc.)
- Identify intentional public endpoints that are documented as unauthenticated by design
- Understand which validation library and pipe configuration the project uses
- Avoid flagging intentional architectural security decisions as findings

If the file does not exist or is not provided, proceed normally — context is optional and non-blocking.


## Orchestrated Review Contract

When dispatched by `review-orchestrator`, follow the provided `reviewer-input.schema.json` payload. Return a `REVIEW_RESULT` object compatible with `.metaproject/skills/gdskills/review/review-orchestrator/reviewer-finding.schema.json`, then a concise markdown summary. Keep findings evidence-based, include concrete `suggested_fix` for every blocker/major, and return `NEEDS_CONTEXT` instead of guessing when required context is missing.

---

