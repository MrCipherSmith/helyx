---
name: perf-check
description: "Use when measuring bundle size, detecting performance regressions, auditing slow queries, or investigating why something is slow. NOT for reviewing a diff's performance impact (use `review-performance`) — this skill measures a project and reports, it does not change code."
triggers:
  - "perf audit"
  - "bundle size"
  - "complexity"
  - "Check performance"
  - "Lighthouse"
  - "Why is it slow"
  - "Optimize performance"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "quality"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
---

# Performance Check

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
- An optimisation that measures neutral is reported with revert as its recommended fix, not as harmless. The burden is on keeping it, never on dropping it: it leaves the code more complicated than it found it, and it survives review precisely because nothing is wrong with it. This rule and the ledger two bullets down are adapted (MIT) from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills); the noise definition and the groundwork exception are ours
- Neutral is a delta that does not clear the noise. Take the before reading three times on one named workload and keep the spread; any after-delta inside that spread is neutral. Indistinguishable from zero is the same verdict as zero, not a smaller win — say which it was, and how many runs said so
- Record the attempt in the flow journal (`.metaproject/flows/<flow>/journal.md`), in the same change as the revert: what was tried, the before and after with the command and the workload that produced them, and why it did not help *here*. "Tried caching, didn't help" is worse than no entry — it forecloses the idea for the next agent and leaves them nothing to overturn it with
- Groundwork is the only exception: a neutral change survives when the change it is a prerequisite for is in the same branch and the two measure a win together. A payoff promised for later is not a measurement — revert, and record what the pair would have to show

## Red Flags

| Rationalization | Why it is wrong |
|---|---|
| "I found the slow thing — swapping it takes one line, I'll just fix it" | This skill reports. A fix slipped inside an audit is an unreviewed change nobody asked for, and it destroys the before/after measurement the audit exists to produce |
| "There's no `dist/` yet, so bundle size is 0 / I'll skip it quietly" | A measurement not taken is `not measured`, never zero. A zero in a performance report reads as "nothing to worry about" — build first, or say the step did not run and why |
| "No URL for Lighthouse, but I know roughly what this app would score" | Never print a number no command produced. An estimated score is indistinguishable from a measured one once it is in the report |
| "This dependency is 200KB, so it's the bottleneck" | Bundle weight is not runtime cost, and neither is import size. Say which metric you measured; a heavy dependency that is loaded once and never runs in the hot path is not the answer to "why is it slow" |
| "I'll list every anti-pattern I spotted so nothing is missed" | An unranked list of twenty findings gets acted on as zero. Sort by estimated impact and put the number next to each one |

## Verification

Do not report the audit as done until all of the following hold:

- Every number in the report came from a command that actually ran; any phase that could not run says `NOT RUN — <reason>` instead of showing a zero
- `git status` is unchanged from before the audit — no source, config, or lockfile was modified
- Every heavy dependency flagged carries a named alternative and an estimated saving
- Recommendations are ordered by estimated impact, largest first
- Every optimisation this audit measured that came out neutral is reported with revert as its recommended fix, and its attempt is in the flow journal with both readings, the workload, and the run count that made it neutral
- The report states which scope was detected (frontend / backend / fullstack) and which phases it therefore ran
