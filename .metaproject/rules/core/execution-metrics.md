---
type: rule
id: execution-metrics
priority: reference
generated_by: keryx
---

# Execution Metrics (opt-in efficiency report)

A uniform, honest end-of-run report so different runs of the same skill can be
compared. Observational only — it never changes the task.

## When it applies

ONLY when a skill is run **directly by a user** (not dispatched as a subagent by
an orchestrator) — this includes when the user runs an orchestrator itself.

At the START of such a run, ask exactly one yes/no question and wait:

> Collect execution statistics for this run? (yes / no)

- Skip the question if the user already answered it (in the prompt or a prior
  turn), or if you are a dispatched subagent (never ask; never emit the report —
  the top-level orchestrator owns it).
- If **no** → proceed normally, add nothing.
- If **yes** → do the task as usual, then append the `## Execution Metrics`
  section (below) as the LAST thing in your final response.

Do NOT alter, slow, or reshape the main task to gather metrics. If gathering a
metric would require extra work, mark it `unknown` instead.

## Persistence (artifact-producing skills)

Skills that create artifacts (flow-*, autodoc-*, job-*, docpack-*, documenters,
gdwiki enrichment, or anything that writes files) MUST also save the report:

- Flows → `<flow-dir>/metrics/run-<ISO-timestamp>.md`
- Otherwise → `.metaproject/data/<primary-module>/metrics/run-<ISO-timestamp>.md`

Create the directory. Use a filesystem-safe timestamp (colons → `-`). Print the
saved path under the table. This lets the post-commit hook and future runs find
past reports.

## Honesty rules (do not fabricate)

- Never invent an exact value. If a metric is not exposed by the CLI/runtime,
  write `unknown` or `estimated` and name the source in the `Source` column.
- If the CLI/runtime exposes real usage/tokens/cost/duration, use those exact
  numbers and mark `Source = cli`.
- Tokens/cost: exact ONLY if the runtime surfaces them. Otherwise `estimated`
  with a one-line basis (e.g. "≈ files_read × avg size"), or `unknown`. Never a
  precise-looking guess.
- Counts you can observe from your own tool calls (shell commands, files
  read/modified, subagents) are `counted`; git-derived numbers are `git`.

## `## Execution Metrics` section (required — emit even if many values are `unknown`)

| Metric | Value | Source | Notes |
|---|---:|---|---|
| run_mode | user-direct / orchestrator | self | how this skill was invoked |
| skill | ... | self | skill name + version |
| model_used | ... | self/cli | model id if known |
| started_at | ... | system/self | ISO timestamp if known |
| finished_at | ... | system/self | ISO timestamp if known |
| wall_time_minutes | ... | measured/estimated | total elapsed time |
| total_tool_calls | ... | counted | number of shell/tool calls made |
| shell_commands_run | ... | counted | count only terminal/shell commands |
| files_read | ... | counted/estimated | unique files inspected |
| files_modified | ... | counted | unique files changed |
| lines_changed | ... | git | added + removed (`git diff --stat`) if available |
| tests_or_checks_run | ... | counted | list commands separately below |
| tests_or_checks_passed | ... | counted | pass/fail/unknown |
| subagents_used | ... | counted | 0 if none |
| subagent_names | ... | counted | comma-separated or none |
| tokens_total | ... | cli/unknown/estimated | exact only if runtime exposes it |
| tokens_input | ... | cli/unknown/estimated | exact only if runtime exposes it |
| tokens_output | ... | cli/unknown/estimated | exact only if runtime exposes it |
| tokens_per_subagent | ... | cli/unknown/estimated | map subagent -> tokens if available |
| context_sources_used | ... | counted | e.g. AGENTS, CLAUDE, keryx index, wiki, graph |
| keryx_used | yes/no | observed | whether keryx commands/files were used |
| keryx_commands_run | ... | counted | exact commands if any |
| graph_used | yes/no | observed | gdgraph / graphify / keryx graph usage |
| wiki_used | yes/no | observed | .metaproject/wiki or keryx wiki usage |
| health_used | yes/no | observed | keryx health usage |
| artifacts_written | ... | counted | files/pages this run created or updated |
| blockers_or_retries | ... | counted | failed commands, retries, missing deps |
| final_status | done / partial / blocked | self | final outcome |

After the table, add:

1. **Commands Run** — every command actually executed (verbatim, in order).
2. **Artifacts Changed** — every file created/modified (paths).
3. **Comparison Notes** — 3–5 bullets on what likely affected speed / quality /
   amount of context (e.g. graph freshness, batch size, model tier, cache).
4. **Metric Reliability** — which metrics are exact (`counted`/`git`/`cli`),
   which are `estimated` (and why), which are `unknown` (and why unavailable).

The `## Execution Metrics` section is MANDATORY when stats were opted in, even if
several values are `unknown`.
