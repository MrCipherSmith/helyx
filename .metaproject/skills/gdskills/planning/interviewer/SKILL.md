---
name: interviewer
description: "Use when requirements are ambiguous and precise clarification is needed before proceeding with a complex task."
triggers:
  - "Interview me"
  - "Ask me questions"
  - "Clarify requirements"
  - "Gather requirements"
  - "What do you need to know"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "meta"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

<SUBAGENT-STOP>
If you were dispatched as a subagent to execute a specific task, skip this skill entirely.
This skill is for orchestrators and interactive session-level routing only.
Proceed directly with your assigned task.
</SUBAGENT-STOP>

# Interviewer

## Purpose

Gathers precise context through focused, critical questions before a complex skill executes. Prevents wasted work from wrong assumptions. Asks **one question at a time**, provides options where possible, and skips questions the context already answers.

**Input schema:**
```
topic: string           — what is being worked on
goal: string            — which skill will use these answers
context?: {             — optional, provided by calling skill
  codebase_summary?: string
  recent_changes?: string
  relevant_files?: string[]
  existing_analysis?: string
}
```

**Output schema:**
```
answers: [{question, answer, confidence: "certain"|"assumption"|"unknown"}]
derived_context: string   — all gathered info as one coherent block
ready_to_proceed: boolean
blockers?: string[]       — unresolved critical unknowns
```

## When to Use

- Called by `job-orchestrator`, `brainstorm`, `feature-dev` at start of Phase 0
- Directly by user: `/interviewer <topic>` — runs context-collector first if no context provided
- When requirements are vague or ambiguous

## Workflow

### If called by another skill (context provided)
1. Parse input context
2. Determine what's still unknown or ambiguous for the stated goal
3. Decide number of questions needed (typically 2-6)
4. Skip questions already answered by context
5. Ask questions one at a time
6. Produce output schema

### If called directly by user (no context)
1. Ask: "What are we working on?" (if topic not in arguments)
2. Run `context-collector` as sub-agent to gather codebase context
3. Proceed as above with collected context

## Question Rules

- **One question at a time** — never ask multiple at once
- **Provide options when possible**:
  ```
  What is the primary trigger for this feature?
  A) User request / new requirement
  B) Tech debt or refactor
  C) Bug or incident in production
  D) Other (describe)
  ```
- **Skip if already known** — if context answers a question, don't ask it
- **Be critical** — focus on questions that would change the approach
- **Max 8 questions** — stop when enough context is gathered
- **Confirm before proceeding** — summarize gathered context and ask if correct

## Question Bank by Goal Type

### For implementation goals
- What is the expected input/output?
- What are the edge cases that must be handled?
- Are there existing similar patterns in the codebase to follow?
- What is the performance/scale requirement?
- What should NOT be changed (constraints)?

### For review goals
- What specific concerns should the review focus on?
- Are there known existing issues to watch for?
- What is the acceptance criteria?

### For architecture/design goals
- What are the hard constraints (performance, compat, timeline)?
- What does success look like in 6 months?
- What are you most worried about?
- Who else is affected by this decision?
