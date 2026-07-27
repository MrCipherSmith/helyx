---
name: perf-check
description: "Performance analysis: bundle size measurement, Lighthouse audit, dependency weight analysis, code-level anti-pattern detection (N+1, missing memoization, heavy imports). Produces prioritized report with optimization suggestions."
triggers:
  - "/perf-check"
  - "Check performance"
  - "Bundle size"
  - "Lighthouse"
  - "Why is it slow"
  - "Optimize performance"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "performance"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Performance Check

Analyze and report on project performance metrics.

## Arguments

- `/perf-check` — full analysis
- `/perf-check --bundle` — bundle size only
- `/perf-check --lighthouse <url>` — Lighthouse audit
- `/perf-check --deps` — dependency weight analysis
- `/perf-check --code` — code-level pattern check

## Workflow

### Phase 1: Detect Scope
- **Frontend**: bundle size, lighthouse, dependency weight
- **Backend**: startup time, memory, dependency weight
- **Fullstack**: both

### Phase 2: Bundle Analysis
- Build and measure output: `du -sh dist/ build/ .next/`
- Check largest dependencies: `npx -y cost-of-modules`
- Identify tree-shaking opportunities

### Phase 3: Lighthouse (if URL available)
```bash
npx -y lighthouse <url> --output json --chrome-flags="--headless --no-sandbox"
```

### Phase 4: Dependency Analysis
Flag heavy dependencies:
- `moment` → `dayjs` or `date-fns`
- `lodash` (full) → `lodash-es` or individual imports
- `aws-sdk` v2 → `@aws-sdk/client-*` v3

### Phase 5: Code Anti-patterns
- N+1 queries (loop with await)
- `JSON.parse(JSON.stringify())` for clone
- Missing `useMemo`/`useCallback` on expensive operations
- Sync file ops in request handlers
- Missing database indexes

### Phase 6: Report

```markdown
# Performance Report

## Bundle
- Total: 1.2MB (gzipped: 380KB)

## Issues Found
🔴 moment.js adds 230KB — replace with dayjs (2KB)
🟡 Full lodash import — use lodash-es

## Recommendations (by impact)
1. Replace moment → dayjs (saves ~228KB)
2. Code-split vendor chunk
```

## Rules

- Don't make changes — only analyze and report
- Sort recommendations by estimated impact
- Include specific numbers (KB saved, ms improved)
- Suggest alternatives for every heavy dependency flagged
