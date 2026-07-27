---
title: Subagent Status Protocol
category: agent-discipline
version: 1.0.0
applies_to: all subagents dispatched by an orchestrator
---

# Subagent Status Protocol

## Why This Exists

Orchestrators cannot make good decisions based on free-text responses. When a subagent returns a wall of prose ending with "everything looks good", the orchestrator has three bad options: parse it, guess, or trust it blindly. All three fail at scale.

**Known failure modes this protocol prevents:**

- **Silent failures** — subagent hits a blocker, works around it, says "Done". Orchestrator continues. The workaround breaks something downstream.
- **Ambiguous "done"** — task is "complete" but half the acceptance criteria were skipped. Orchestrator only finds out during review.
- **Buried blockers** — "I couldn't find the config file so I assumed X" appears in paragraph 4. Orchestrator never re-dispatches with the right information.
- **Context gaps** — subagent guesses at missing context and gets it wrong. Four tasks downstream are now built on a wrong assumption.

This protocol makes subagent state machine-readable on the first line.

---

## Iron Law

**THE FIRST LINE OF EVERY SUBAGENT FINAL RESPONSE MUST BE `STATUS: <STATUS>`**

No exceptions. No preamble. No "Here's my report:" before the status line.

If the first line is not `STATUS: <STATUS>`, the orchestrator MUST treat the response as `NEEDS_CONTEXT` and request a properly formatted response.

---

## The Four Statuses

### `DONE`
Task fully complete. All acceptance criteria met. Orchestrator can continue the pipeline.

### `DONE_WITH_CONCERNS`
Task complete, but the orchestrator should know something before continuing. This is NOT a failure — it is a completed task that carries information the orchestrator needs to make a good decision.

Use when:
- Implementation required a meaningful interpretation of ambiguous criteria
- A workaround was used for a non-blocking issue
- Something unexpected was discovered that may affect later steps
- Verification passed but with warnings the orchestrator should see

### `BLOCKED`
Cannot continue. A specific decision or action from the orchestrator is required before the subagent can make progress.

Use when:
- A required file, resource, or dependency does not exist
- Two valid approaches exist with significantly different tradeoffs and the subagent cannot choose alone
- A command failed in a way that requires orchestrator-level intervention (not a self-fixable error)
- The task scope needs to be clarified before proceeding

Do NOT use `BLOCKED` for errors you can fix yourself. Self-fix first (up to your retry limit), then report `BLOCKED` if still stuck.

### `NEEDS_CONTEXT`
Specific information is missing that would allow the subagent to proceed correctly. Different from `BLOCKED`: the subagent knows what it needs and believes the orchestrator has it.

Use when:
- A required input field in the task object is missing or empty
- Module patterns, library docs, or API signatures are needed but weren't provided
- The task references files or components that don't exist and no context explains them
- Acceptance criteria use terms not defined anywhere in the provided context

---

## Exact Response Formats

### `STATUS: DONE`

```
STATUS: DONE

## Completed
- [concrete list of what was done, one item per acceptance criterion]

## Files changed
- path/to/file — description of change
- path/to/other — description of change

## Verification
- lint: pass
- type-check: pass
- tests: 14 passed, 0 failed
```

### `STATUS: DONE_WITH_CONCERNS`

```
STATUS: DONE_WITH_CONCERNS

## Completed
- [concrete list of what was done]

## Files changed
- path/to/file — description of change

## Concerns for orchestrator
- [specific concern] — [why it matters and what the orchestrator might want to do about it]
- [second concern if any]

## Verification
- lint: pass
- type-check: pass
- tests: 14 passed, 0 failed
```

### `STATUS: BLOCKED`

```
STATUS: BLOCKED

## Reason
[One specific blocker, stated plainly. Not a list of everything that could go wrong — just the one thing stopping progress right now.]

## What I need from orchestrator
[Specific ask. "Please provide X" or "Please decide between A and B" — not "more information".]

## Work completed so far
- [list anything that was finished before hitting the blocker, so the orchestrator knows what to preserve]
```

### `STATUS: NEEDS_CONTEXT`

```
STATUS: NEEDS_CONTEXT

## Missing information
[What specifically is needed — name the field, file, pattern, or decision that is absent.]

## Where it might be found
[Suggestion: "likely in package.json", "the context-collector output", "the issue body", etc.]

## Work completed so far
- [list anything that was finished before the gap was discovered]
```

---

## What the Orchestrator Does for Each Status

| Status | Orchestrator action |
|--------|---------------------|
| `DONE` | Accept result. Extract files changed, commits, verification results. Continue to next step. |
| `DONE_WITH_CONCERNS` | Read concerns section. Decide: (a) continue as-is, (b) note concern for later step, or (c) re-dispatch with adjusted scope. Do NOT silently discard concerns. |
| `BLOCKED` | Stop pipeline on this task. Resolve the specific blocker (provide the file, make the decision, fix the dependency). Re-dispatch. Do NOT proceed to dependent steps while blocked. |
| `NEEDS_CONTEXT` | Provide the missing information. Re-dispatch the task with the enriched context. If the information is not available, escalate to user. |

---

## Red Flags — Rationalizations That Must Be Rejected

The following thoughts indicate a subagent is about to violate the protocol. Reject them before writing the response.

- **"The result is obvious, I'll just say Done"** — If you are summarizing the result in prose and appending "Done" at the end, you are not following the protocol. Move `STATUS: DONE` to the first line and structure the rest.

- **"I'll add a note at the end instead of BLOCKED"** — Notes at the end are invisible to automated orchestrators. If you are blocked, the status must be `BLOCKED`. The note goes in the `## Reason` field.

- **"It's mostly done, DONE_WITH_CONCERNS feels like admitting failure"** — `DONE_WITH_CONCERNS` is not a failure status. It is a success status with an attached signal. Use it freely when something is worth the orchestrator knowing.

- **"NEEDS_CONTEXT would slow things down, I'll just guess"** — Guessing propagates errors downstream. One `NEEDS_CONTEXT` and a re-dispatch is cheaper than four tasks built on a wrong assumption.

- **"I didn't meet one criterion but I'll say DONE and mention it in notes"** — If an acceptance criterion is not met, the status is not `DONE`. Use `DONE_WITH_CONCERNS` and name the unmet criterion in the concerns section.

- **"The orchestrator will figure it out from my explanation"** — The orchestrator reads `STATUS:` on line 1. Everything else is secondary. Do not make the orchestrator parse free text to determine the outcome.
