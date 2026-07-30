# flow-init Skill (initialization orchestrator)

Initialize a flow from a problem description or a GitHub issue URL. Runs as
Phase 1 of the gdskills `flow-orchestrator`, or standalone. Non-trivial
initialization is decomposed by dispatching gdskills workers; trivial flows can
be filled inline.

## Worker communication (schema-governed)

Workers inherit no session state - construct each dispatch explicitly
(`.metaproject/rules/core/subagent-context-construction.md`). Every dispatch is
a `subagent-dispatch` object
(`.metaproject/core/gdskills/contracts/subagent-dispatch.schema.json`) and every
worker reply is a `subagent-result`
(`.metaproject/core/gdskills/contracts/subagent-result.schema.json`) whose first
line is `STATUS:` (`.metaproject/rules/core/subagent-status-protocol.md`). Set
`run_id` to the flow id and `dispatch_id` to `<flow-id>-<step>`.

## Workflow

1. Create the package: `keryx flow init --issue <url>` or
   `--title "<problem>"`. The CLI scaffolds the package and collects
   deterministic context (issue body, memory search, gdgraph artifacts, health).
2. Enrich context - dispatch `context-collector` with `context_refs` to the
   flow package; it writes compact findings, not raw dumps. For an issue also
   dispatch `issue-analyzer`; for a described feature, `feature-analyzer`.
   Fold each `subagent-result` into context.md.
3. Formalize description.md: problem, expected outcome, out of scope.
4. Brainstorm approaches - dispatch `brainstorm` (2-3 options, trade-offs);
   record the chosen approach and rejected alternatives in plan.md.
5. If hard requirements are ambiguous, dispatch `interviewer`: focused
   questions with options and a recommendation. Do not guess hard requirements.
6. Break work into tasks: `keryx flow task add <id> --title ... --kind
   context|implement|test|review|docs` (defaults T1-T4 already exist; adjust).
7. Write acceptance-criteria.md: hard, verifiable `- ACn:` criteria grounded in
   the collected evidence.
8. Re-verify the whole package, then freeze and hand off:
   `keryx flow freeze <id>` -> `keryx flow start <id>`.

Read each worker's `STATUS:` first: `NEEDS_CONTEXT`/`BLOCKED` -> enrich and
re-dispatch (do not mark done); `DONE`/`DONE_WITH_CONCERNS` -> fold the result
in and journal any concerns. After freeze, the implementor works the plan and
must not modify acceptance criteria or flow state directly.
