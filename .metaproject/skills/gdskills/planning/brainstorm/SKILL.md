---
name: brainstorm
description: "Use when exploring architecture decisions, tech choices, feature ideas, or any open-ended problem that benefits from multiple perspectives. NOT for: writing the chosen option up as a formal requirements document (use prd-creator)."
triggers:
  - "brainstorm"
  - "explore options"
  - "architecture decision"
  - "Let's think about"
  - "What are options for"
  - "How should we approach"
  - "Compare approaches"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "planning"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
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

## Red Flags

Stop and re-read this skill if you are thinking:

| Rationalization | Rebuttal |
|---|---|
| "All three agents converged on the same option, so it must be right." | Three agents given one framing usually converge because the framing already decided it. Convergence is evidence about the prompt, not about the option. Check whether all three skipped the same constraint before calling agreement a result. |
| "The best option is obvious, so the comparison matrix is busywork." | The matrix is the only part the user can audit. Without effort, risk and time-to-ship side by side, "recommended" is an assertion they have to take on trust — and the obvious option is exactly the one whose cost nobody checked. |
| "The Critic raised risks, but they apply to the runner-up, not my pick." | The Critic's questions apply to ALL options by construction. The recommendation must answer each one or explicitly accept it as a known risk. Silently routing a question to the option you did not pick is how the risk ships. |
| "This is early exploration, so effort estimates would be premature." | An idea without an estimate is not actionable, which is the whole output of this skill. A labelled guess (S/M/L, stated as a guess) is usable; no number is not. |
| "The innovative option is more interesting, so it is the better recommendation." | Novelty is not a criterion in the matrix. If the boring option scores better on effort, risk and time to ship, it wins — say so, and put the interesting one in the runner-up slot with the condition that would flip the call. |

## Verification

Before reporting, all of these must hold:

- The Ideas Map has at least two distinct options, each with approach, pros, cons, effort (S/M/L) and risk.
- The comparison matrix has one column per option and a row per criterion — no blank cells.
- Every Critical Question from the Critic is listed, and the recommendation either answers it or names it as an accepted risk.
- The recommendation names a runner-up and the specific condition under which the runner-up would be chosen instead.
- Next steps are concrete actions, each specific enough to become a task — not "investigate further".
- In `--quick` mode: 3-5 scored options in a table and one recommendation. In `--deep` mode: the Security Analyst and UX Advocate perspectives both appear in the synthesis, not just in the agent output.
- Options are grounded in the project's actual stack and constraints; anything assumed about the stack is labelled as an assumption.
