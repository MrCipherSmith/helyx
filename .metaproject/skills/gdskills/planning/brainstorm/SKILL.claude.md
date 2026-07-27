---
description: Structured brainstorming — architecture decisions, problem solving, open exploration
allowed-tools: Read(*), Glob(*), Bash(git log:*), Bash(git branch:*)
---

## Context

- Project: !`basename $(git rev-parse --show-toplevel 2>/dev/null) 2>/dev/null || basename $PWD`
- Current branch: !`git branch --show-current 2>/dev/null || echo "n/a"`
- Recent work: !`git log --oneline -5 2>/dev/null || echo "n/a"`

## Your task

Topic to brainstorm: $ARGUMENTS

Run a structured brainstorm session. Auto-detect mode from topic:

### Mode A — Feature / Architecture
*when topic is about building or designing something*

1. **Restate the problem** in one sentence
2. **Constraints** — perf, compat, team, time, existing stack
3. **5-7 distinct approaches** — each with: catchy name, core idea (1-2 sentences), key trade-off
4. **Wild card** — one unconventional idea that breaks assumptions
5. **Recommendation** — top 2 with reasoning
6. **Open questions** — what must be decided before committing

### Mode B — Problem Solving
*when topic is a bug, failure, or "why is X happening"*

1. **Reproduce** — what fails, when, under what conditions
2. **5 hypotheses** — ordered by likelihood
3. **Fastest disproof** — specific command or check for each
4. **Most likely culprit** — and why
5. **Fix options** — quick fix vs proper fix

### Mode C — Open-ended / Creative
*when topic is vague or exploratory*

1. **Expand the space** — 3 different framings of the question
2. **Diverge** — 10 raw ideas, no filtering
3. **Converge** — cluster into 3 strongest themes
4. **Stress test** — what could go wrong with each?
5. **Next step** — one concrete action

Be direct and opinionated. Never end without a concrete recommendation.
