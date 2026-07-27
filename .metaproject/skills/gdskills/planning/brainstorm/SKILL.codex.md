---
name: brainstorm
description: "Structured brainstorming with multiple thinking perspectives (Pragmatist, Innovator, Critic). Generates ideas, evaluates trade-offs via comparison matrix, produces actionable recommendation. Use for architecture decisions, feature ideation, problem solving, tech choices, naming."
triggers:
  - "/brainstorm"
  - "Brainstorm"
  - "Let's think about"
  - "What are options for"
  - "How should we approach"
  - "Compare approaches"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "ideation"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Brainstorm

Structured brainstorming that explores a topic from multiple angles and converges on actionable options.

## Arguments

- `/brainstorm <topic>` — full brainstorm with 3 parallel agents
- `/brainstorm --quick <topic>` — inline fast brainstorm (no agents, for simple decisions)
- `/brainstorm --deep <topic>` — 5 agents (+Security Analyst, +UX Advocate)
- `/brainstorm --code` — focus on code architecture (reads codebase for context)

## Workflow

### Step 1: Frame the Problem
1. Restate the user's challenge in clear terms
2. Identify constraints: technical, business, quality
3. If in a project directory, scan codebase for relevant context

### Step 2: Diverge — Generate Ideas (3 Parallel Agents)

Launch 3 agents simultaneously:

**Agent 1 — Pragmatist**
> "Propose 2-3 solutions optimizing for speed of delivery, simplicity, and maintainability. Use boring, proven technology. For each: approach, pros/cons, effort (S/M/L)."

**Agent 2 — Innovator**
> "Propose 2-3 unconventional or cutting-edge solutions. Think new patterns, emerging tools, or approaches from other domains. For each: approach, pros/cons, effort."

**Agent 3 — Critic**
> "What are the hidden risks? What will break at scale? What will be painful to maintain? Produce 5-7 critical questions any solution must address."

### Step 3: Converge — Synthesize

```markdown
## Ideas Map
### Option A: [Name]
**Approach:** ... | **Pros:** ... | **Cons:** ...
**Effort:** S/M/L | **Risk:** Low/Med/High

## Critical Questions
(from Critic — apply to ALL options)

## Comparison Matrix
| Criteria        | Option A | Option B | Option C |
|-----------------|----------|----------|----------|
| Effort          | S        | M        | L        |
| Risk            | Low      | Med      | High     |
| Scalability     | ★★★      | ★★★★     | ★★★★★    |
| Time to ship    | 1 week   | 3 weeks  | 6 weeks  |
```

### Step 4: Recommend
1. **Recommended option** with reasoning
2. **Runner-up** and when you'd pick it instead
3. **Next steps** — concrete action items

### Step 5: Discuss
Offer to go deeper on any option or kick off `/feature-dev` / `/prd-creator`.

## Quick Mode (--quick)
Skip agents. Inline: 3-5 options in table, score each, recommend one.

## Deep Mode (--deep)
Add: **Security Analyst** (auth, data exposure, compliance) and **UX Advocate** (complexity, learning curve, accessibility).

## Rules

- Ground ideas in the project's actual tech stack and constraints
- Include effort estimates — ideas without estimates aren't actionable
- The Critic's questions must be answered by the recommendation
- Don't dismiss "boring" solutions — they often win
- End with concrete next steps, not just analysis
