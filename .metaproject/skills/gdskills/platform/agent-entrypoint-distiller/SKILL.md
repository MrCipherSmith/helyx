---
name: agent-entrypoint-distiller
description: "Use when the user asks to split, decompose, distill, or refactor a large AGENTS.md or CLAUDE.md into Metaproject rules and project-specific skills while keeping root entrypoints compact. NOT for: adding a newly learned convention or command to an existing CLAUDE.md (use claude-md-management)."
triggers:
  - "distill claude"
  - "split CLAUDE.md"
  - "разбери CLAUDE.md"
  - "создай правила из CLAUDE.md"
  - "entrypoint rules"
  - "distill AGENTS.md"
  - "разнеси CLAUDE.md по правилам"
metadata:
  version: "1.0.0"
  category: platform
---

# Agent Entrypoint Distiller

Use this skill when root agent files (`AGENTS.md`, `CLAUDE.md`) have grown into
large project manuals and should be converted into local Metaproject knowledge.

## Workflow

1. Read `.metaproject/index.md` and `.metaproject/metaproject.json` if they exist.
2. Run:

```bash
keryx rules distill
```

3. Verify the generated outputs:
   - `.metaproject/rules/entrypoints/index.md`
   - `.metaproject/rules/entrypoints/*.md`
   - `.metaproject/project-skills/entrypoints/*/SKILL.md`
   - compact `AGENTS.md` and `CLAUDE.md` still point to `.metaproject/index.md`
4. If the command changed root entrypoints, check that only global/personal or
   highest-priority always-on instructions remain there.
5. Run focused verification:

```bash
keryx rules sync
keryx flow check
```

`flow check` takes no flow id: it validates every package under `.metaproject/flows/` — id uniqueness, `flow.json` against the published schema, the six required documents, and the acceptance-criteria checksum. With no flows it prints `All flows are consistent.` and exits 0, so it is safe to run either way.

## Red Flags

Stop and re-read this skill if you are thinking:

| Rationalization | Rebuttal |
|---|---|
| "`keryx rules distill` exited 0, so the split is correct." | Exit 0 says the command ran, not that it split well. It happily writes an empty rule, a rule titled after a heading it could not classify, and two rules holding the same paragraph. Open every file listed in step 3 before reporting anything. |
| "The root entrypoint is short now, so the job is done." | Shortness is a side effect, not the goal. A root that no longer points at `.metaproject/index.md`, or that lost an always-on instruction into a rule nothing loads, is a regression that looks like success on a line count. |
| "This section read like a project rule, so I moved it out of the root." | Global, personal and highest-priority always-on instructions stay in the root by design. If you had to guess which kind a section was, it belongs in the ambiguous list for a human — not silently in a rule file. |
| "The project has no flow, so I can skip verification." | `keryx flow check` is not conditional either — with no flows it reports `All flows are consistent.` and exits 0. `keryx rules sync` runs every time; skipping it ships a rules tree whose index and files disagree. |
| "`keryx rules distill` rewrote the root files, so I don't need to read them." | The rewrite is exactly what needs checking. Reading the post-distill `AGENTS.md` and `CLAUDE.md` is the only way to see what was carried out of them. |

## Verification

Before reporting, all of these must hold:

- `keryx rules sync` exits 0.
- `.metaproject/rules/entrypoints/index.md` exists and names every file written under `.metaproject/rules/entrypoints/`.
- Every generated rule and project-skill file is non-empty and was read, not just listed.
- `AGENTS.md` and `CLAUDE.md` both still reference `.metaproject/index.md`.
- `keryx flow check` exits 0. It takes no id and checks every flow package in the project, so a distill that corrupted one reports here even though the distill never touched flows.
- Every section you could not confidently classify appears in the ambiguous list of the Output Contract. An empty ambiguous list on a large entrypoint is a claim, and it must be a true one.

## Output Contract

Report:

- rules extracted count;
- skills extracted count;
- root sections kept count;
- files changed;
- any sections that looked ambiguous and should be reviewed manually.
