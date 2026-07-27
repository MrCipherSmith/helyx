---
name: interview
description: "Critical requirements interviewer: asks targeted clarifying questions one-by-one before expensive operations. Identifies uncertainty zones, provides answer options, adapts follow-ups based on responses. Can trigger mini-brainstorm on ambiguous points. Use before implementation, design, or migration to gather precise context."
triggers:
  - "/interview"
  - "Interview"
  - "Clarify requirements"
  - "Ask questions first"
  - "What do you need to know"
  - "Gather requirements"
metadata:
  author: "MrCipherSmith"
  version: "1.0.0"
  category: "analysis"
license: "MIT"
compatibility: "cursor,codex,zed,opencode,claude"
---

# Interview

Critical requirements interviewer that asks targeted clarifying questions before expensive operations begin. The goal is to eliminate ambiguity and gather precise context so downstream skills (job-orchestrator, feature-dev, prd-creator) produce accurate results.

## Input Contract

When called by another skill (orchestrated mode):
```json
{
  "goal": "what needs to be done (issue title, feature description, task)",
  "context": "collected context from context-collector or another agent",
  "domain": "implement | review | design | migrate | custom",
  "caller": "job-orchestrator | feature-dev | user | prd-creator",
  "known_facts": ["already known facts or decisions"],
  "max_questions": null
}
```

When called standalone: input is the user's free-text description.

## Output Contract

```json
{
  "decisions": [
    {"question": "...", "answer": "...", "impact": "high | medium"}
  ],
  "constraints": ["identified constraints"],
  "assumptions": ["confirmed assumptions"],
  "risks": ["identified risks"],
  "refined_goal": "refined, unambiguous goal statement"
}
```

## Workflow

### Phase 1: Context Acquisition

**Orchestrated mode** (called with context):
- Parse the input contract
- Proceed directly to Phase 2

**Standalone mode** (called by user):
1. Ask the user: "What are you trying to accomplish?"
2. If in a project directory, launch `context-collector` as sub-agent to gather codebase context
3. Wait for context, then proceed to Phase 2

### Phase 2: Uncertainty Analysis

Analyze goal + context to identify "uncertainty zones" — areas where:
- Multiple valid approaches exist
- Requirements are ambiguous or contradictory
- Technical constraints are unclear
- Scope boundaries are undefined
- Dependencies or impacts are unknown

Each uncertainty zone becomes a potential question. Skip questions where the answer is already clear from context or known_facts.

Determine question count dynamically:
- Simple task with good context → 2-3 questions
- Complex task with sparse context → 5-7 questions
- Stop when remaining uncertainty is low enough to proceed confidently

### Phase 3: Interactive Interview

Ask questions **one at a time**, each with answer options where possible:

```
❓ Question 1/~N: [Topic — e.g., "Authentication approach"]

[Brief context why this matters for the task]

  A) Option one (brief explanation)
  B) Option two (brief explanation)
  C) Option three
  D) Need more context — tell me more

> answer with letter or free text
```

**Adaptation rules:**
- If user picks an option → record decision, move to next question
- If user answers in free text → extract the decision, confirm understanding
- If user picks "Need more context" (D) → provide deeper explanation or trigger a mini `/brainstorm --quick` on this specific point, then re-ask
- If user says "skip" or "don't care" → record as assumption with medium confidence, move on
- Adjust remaining questions based on answers (some questions become irrelevant after certain decisions)

### Phase 4: Synthesis

After all questions are answered:

1. Compile the output contract:
   - **decisions**: all Q&A pairs with impact level
   - **constraints**: technical and business constraints identified
   - **assumptions**: things assumed true but not explicitly confirmed
   - **risks**: potential issues surfaced during interview
   - **refined_goal**: clear, unambiguous restatement of the goal

2. Present summary to user:
```markdown
## Interview Summary

### Goal (refined)
[Clear statement]

### Key Decisions
1. [Decision] — impact: high
2. [Decision] — impact: medium

### Constraints
- [Constraint]

### Assumptions (please verify)
- [Assumption]

### Risks
- [Risk]
```

3. Ask: "Does this look right? Anything to correct before we proceed?"

### Phase 5: Handoff

Return the output contract to the calling skill, or if standalone — ask what the user wants to do next:
- "Start implementing? I can run `/feature-dev`"
- "Create a PRD? I can run `/prd-creator`"
- "Need more brainstorming? Try `/brainstorm`"

## Question Design Principles

Good interview questions are:
- **Specific**: "Should auth use JWT or session cookies?" not "How should auth work?"
- **Impactful**: the answer meaningfully changes the implementation
- **Non-obvious**: don't ask things derivable from the codebase
- **Ordered by dependency**: ask foundational questions first (they may make later questions unnecessary)

Provide answer options when:
- There are 2-4 clear alternatives
- The user might not know all options available
- You want to speed up the interview

Skip options when:
- The question requires a free-text answer (e.g., "What's the deadline?")
- The space of answers is too large

## Integration with Other Skills

```
job-orchestrator → context-collector → interview → plan → execute
feature-dev → interview (Phase 1) → design → implement
prd-creator → interview → requirements document
```

The interview skill is designed to be composable — any skill that needs user input before proceeding can call it.

## Rules

- NEVER ask more than 7 questions (keep it focused)
- NEVER ask questions whose answers are already in the provided context
- ALWAYS provide answer options when 2-4 clear alternatives exist
- ALWAYS adapt subsequent questions based on previous answers
- If the user seems impatient or says "just do it" — stop interviewing, document remaining unknowns as assumptions, and proceed
- One question at a time — never dump all questions at once
