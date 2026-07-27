---
description: Performance analysis — bundle size, slow queries, memory, async patterns
allowed-tools: Bash(*), Read(*), Glob(*)
---

## Context

- Build output: !`du -sh dist/ build/ .next/ out/ 2>/dev/null | sort -h || echo "not built"`
- Running containers: !`docker stats --no-stream 2>/dev/null | head -5 || echo "none"`
- Package manager: !`ls bun.lockb 2>/dev/null && echo "bun" || echo "npm"`

## Your task

Performance analysis for: $ARGUMENTS (or full analysis if empty)

### 1. Bundle size (frontend)
List top 10 largest files in dist/build. Flag > 500KB uncompressed or > 150KB gzipped.

### 2. Dependency weight
```bash
du -sh node_modules/*/ 2>/dev/null | sort -hr | head -20
```

### 3. Backend patterns (static analysis)
Scan source files for:
- `await` inside `forEach`/`map` loops → should use `Promise.all`
- `SELECT *` patterns → should project columns
- Missing `.limit()` on list queries
- Loop with DB call (N+1 pattern)

```bash
grep -rn "\.forEach\|\.map" --include="*.ts" src/ 2>/dev/null | grep -i await | head -20
grep -rn "SELECT \*" --include="*.ts" --include="*.sql" . 2>/dev/null | grep -v node_modules | head -10
```

### 4. Memory (if running)
```bash
docker stats --no-stream 2>/dev/null
pm2 list 2>/dev/null
```

### Report
Group by priority:
- **Critical** (> 50% improvement possible)
- **High** (significant impact)
- **Medium** (worth fixing)

Include file:line references.
