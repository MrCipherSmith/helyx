---
description: Security audit — npm/bun audit, dependency vulnerabilities, secrets scan
allowed-tools: Bash(*)
---

## Context

- Package manager: !`ls bun.lockb yarn.lock pnpm-lock.yaml package-lock.json 2>/dev/null | head -1 || echo "unknown"`
- Bun version: !`bun --version 2>/dev/null || echo "n/a"`
- Dependencies: !`cat package.json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('dependencies',{})), 'prod,', len(d.get('devDependencies',{})), 'dev')" 2>/dev/null || echo "unknown"`

## Your task

Run a comprehensive security audit.

### Step 1 — Dependency vulnerabilities
- `bun.lockb` → `bun audit`
- `package-lock.json` → `npm audit --json`
- `yarn.lock` → `yarn audit`

Group: **critical → high → moderate → low**

### Step 2 — Outdated packages
`bun outdated 2>/dev/null || npm outdated` — flag 2+ major versions behind

### Step 3 — Secrets scan
```bash
git log --all --full-history -- "*.env" "*.key" "*.pem" 2>/dev/null | head -20
grep -r "password\s*=\s*['\"][^'\"]\|api_key\s*=\s*['\"][^'\"]\|secret\s*=\s*['\"][^'\"]" \
  --include="*.ts" --include="*.js" -l . 2>/dev/null | grep -v node_modules
```

### Step 4 — Docker image scan (if Dockerfile present)
`docker scout cves $(docker build -q .) 2>/dev/null || echo "Docker Scout not available"`

### Report
- Total by severity
- Top 3 critical/high with CVE
- Immediate actions
- Packages safe to ignore (dev-only)
