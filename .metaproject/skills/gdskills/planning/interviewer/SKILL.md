---
name: interviewer
description: "Use when a request is ambiguous and must be pinned down BEFORE any context is collected — the entry-point interview that turns a vague or expensive ask into a scoped brief. This is the `custom`-intent gate job-orchestrator runs at 0.1.5. NOT for: clarifying implementation specifics AFTER context is already collected — use `interview` instead."
triggers:
  - "ask questions"
  - "clarify requirements"
  - "interview"
  - "Interview me"
  - "Ask me questions"
  - "Gather requirements"
  - "What do you need to know"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "planning"
  compatible_harnesses: "cursor,codex,zed,opencode,claude"
license: "MIT"
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
summary_confidence: "certain"|"assumption"|"unknown"   — weakest confidence in answers
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
- **Confirm before proceeding** — summarize gathered context, state the summary's own confidence (the weakest of the answers it rests on), and ask if correct

## Question Bank by Goal Type

### For implementation goals
- What is the expected input/output?
- What are the edge cases that must be handled?
- What is the performance/scale requirement?
- What should NOT be changed (constraints)?

### For review goals
- What specific concerns should the review focus on?
- What is the acceptance criteria?

### For architecture/design goals
- What are the hard constraints (performance, compat, timeline)?
- What are you most worried about?
- Who else is affected by this decision?

## Red Flags

Stop and re-read this skill if you are thinking:

| Rationalization | Rebuttal |
|---|---|
| "These three questions are related, so I'll ask them in one message to save time." | One question at a time is the rule, and it is not politeness. A batch gets one answer to the easiest item and silence on the rest, which you then record as if it had been answered. |
| "The answer was vague, but I understood the gist, so `ready_to_proceed: true`." | A gist is an assumption. Either ask the follow-up, or record the item in `blockers` with `confidence: "assumption"` and leave `ready_to_proceed` false. Proceeding on a gist is exactly the wasted work this gate exists to prevent. |
| "They said 'sure, that sounds about right', so that is a yes and `ready_to_proceed: true`." | A hedge is not a refusal and it is not approval. This is not the vague-answer case above — you understood the answer perfectly, and it committed the user to nothing. Name the hedge back ("that is a 'probably' — is it a yes?") and ask the question that forces one. If no commitment comes, the item is recorded as `confidence: "assumption"`, never as confirmation. (That a hedged agreement is not approval is adapted (MIT) from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills); naming the hedge back and the confidence enum are ours.) |
| "I inferred the answer from the codebase, so I can mark it `certain`." | `certain` means the user said it. An inference is `assumption`, even a good one — the confidence field is the only signal downstream skills have about which parts of `derived_context` are load-bearing guesses. |
| "I've hit the 8-question limit and still don't know, so I'll pick the likely answer." | The limit is a stop rule, not a licence to invent. Remaining unknowns go into `blockers`, `ready_to_proceed` goes false, and the caller decides. |
| "Context-collector already ran, so anything still missing must not matter." | Collected context answers what the codebase knows, not what the user intends. Scope, priority and what must NOT change are never in the codebase, and those are the answers that change the approach. |
| "I was dispatched as a subagent with a task, and the task is unclear, so I'll interview." | See the SUBAGENT-STOP block at the top: a dispatched subagent proceeds with its assigned task. Interviewing from inside a dispatch asks questions nobody is there to answer. |

## Verification

Before returning, all of these must hold:

- Every entry in `answers` carries a question, an answer, and a `confidence` value from the enum — no blank or invented confidences.
- No question was asked that the provided context already answered, and no two questions were sent in one message.
- At most 8 questions were asked.
- Every `assumption` or `unknown` was either resolved with a follow-up or is listed in `blockers`.
- `summary_confidence` equals the weakest confidence in `answers`, and was stated when the summary was read back — a user approving a summary built on assumptions was told that is what they were approving.
- `ready_to_proceed` is `false` whenever `blockers` is non-empty, and `true` only after the user confirmed the summarized context.
- `derived_context` reads as one coherent block a downstream skill can act on, and states which of its claims are assumptions.
