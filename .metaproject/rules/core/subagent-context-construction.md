---
title: Subagent Context Construction
category: orchestration
applies_to: job-orchestrator, any orchestrator that dispatches subagents
---

# Subagent Context Construction

## The Principle

Every subagent dispatch must include an **explicitly constructed context block**. Subagents must not rely on inherited session history. The orchestrator constructs context — the subagent receives it, never retrieves it on its own.

This is not a best practice. It is a hard requirement.

---

## Required Fields in Every Subagent Dispatch

Every prompt sent to a subagent must contain all of the following fields:

```
## Task
[Specific task — what exactly to do, no ambiguity]

## Acceptance Criteria
[List of criteria — when is this task considered done]

## Context
[Only relevant information — decisions made, constraints, background]

## Files to read
[Specific list of file paths the subagent must read before acting]

## Constraints
[What must NOT be done — files to avoid, patterns to not introduce, etc.]
```

**None of these fields may be omitted.** A dispatch without all five fields is incomplete.

---

## Principles of Context Construction

### 1. Minimality
Pass only what this specific task needs. Do not dump job state, prior agent output, or full conversation history into the prompt. Every extraneous token increases hallucination risk and degrades the subagent's focus.

### 2. Explicitness
Better to be overly explicit than implicit. If you think the subagent "obviously" knows something, spell it out anyway. The subagent has no session memory. It only knows what you give it.

### 3. Isolation
The subagent must not assume anything about the state of the world that you have not explicitly told it. It cannot see what previous agents did, what decisions were made in earlier phases, or what files were modified — unless you include that information in the prompt.

### 4. Concreteness
Use absolute file paths, not vague pointers. Write `.metaproject/skills/gdskills/orchestration/task-implementer/SKILL.md`, not "look in the skills directory". Write `src/store/PipelineStore.ts`, not "the store file".

---

## Template Dispatch Block

Use this template for every subagent dispatch:

```
Task({
  description: "<one-line summary for logs>",
  subagent_type: "general",
  prompt: |
    ## Task
    <Exactly what to do — no ambiguity>

    ## Acceptance Criteria
    - <criterion 1>
    - <criterion 2>
    - <criterion 3>

    ## Context
    <Relevant decisions, constraints, and background — only what matters for THIS task>

    ## Files to read
    - <absolute/path/to/file1.ts>
    - <absolute/path/to/file2.ts>

    ## Constraints
    - Do NOT modify <file or pattern>
    - Do NOT introduce <pattern>
    - <other hard stops>
})
```

---

## Red Flags — Stop and fix your dispatch if you are thinking:

| Rationalization | Why it's wrong |
|---|---|
| "The subagent will figure out what it needs" | BLOCKED — the subagent has no session context. It will hallucinate or produce generic output. |
| "I'll pass the full conversation history" | Wastes the subagent's context window with irrelevant history and creates hallucination surface area. Pass only what is needed. |
| "The task is obvious, minimal context needed" | Missing context = missing output. Obviousness to you (with full session context) means nothing to an isolated subagent. |
| "Context from the previous subagent will carry over" | It won't. Each subagent starts fresh. The orchestrator bridges state between agents — explicitly. |
| "I'll tell it to read state.json if it needs more context" | The subagent should not be retrieving orchestrator state. The orchestrator constructs context. The subagent receives it. |

---

## Iron Law

**EVERY SUBAGENT DISPATCH MUST INCLUDE AN EXPLICITLY CONSTRUCTED CONTEXT BLOCK WITH ALL FIVE FIELDS: TASK, ACCEPTANCE CRITERIA, CONTEXT, FILES TO READ, AND CONSTRAINTS.**

A dispatch that omits any of these five fields is invalid and must not be executed.
