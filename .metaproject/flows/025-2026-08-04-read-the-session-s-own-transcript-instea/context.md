# Context

Collected deterministically by `keryx flow init` at 2026-08-04T22:16:40.990Z.
The flow-init skill enriches this with formalization, brainstorm results, and
interview answers.

## Related Memory

- [accepted/task-note] Coverage programme: what is done, what is open, what is next - `.metaproject/memory/task-notes/coverage-programme-state.md`
- [accepted/known-mistake] One rule in several files diverges, and review does not catch it - `.metaproject/memory/known-mistakes/duplicated-knowledge-diverges.md`
- [accepted/known-mistake] A comment that claims agreement is not a mechanism - `.metaproject/memory/known-mistakes/comment-asserts-more-than-code.md`

## Code Graph

- `.metaproject/data/gdgraph/artifacts/summary.md`
- `.metaproject/data/gdgraph/artifacts/module-map.json`

Use `keryx gdgraph affected <file>` for blast radius.

## Code Health

- gate: warn (as of 2026-08-04T17:37:31.139Z)
- refresh: `keryx health run`

## Enabled Metaproject Modules

- gdgraph
- gdctx
- gdwiki
- gdskills
- memory
- tasks
- health
- testing
- security

## Agent Findings

### The transcript file, verified

Sampled a live interactive session's file during analysis
(`~/.claude/projects/-home-altsay-bots-helyx/<uuid>.jsonl`, 1.5 MB and growing
while the session ran). Entry types present, by count:

```
assistant 115 · user 75 · attachment 243 · mode 22 · permission-mode 22
last-prompt 21 · queue-operation 10 · system 8
```

An `assistant` entry carries:

```
keys:   cwd, effort, entrypoint, gitBranch, isSidechain, message,
        parentUuid, requestId, sessionId, session_id, timestamp, type
blocks: [("thinking", …)] · [("tool_use", "ToolSearch")]
usage:  input_tokens, output_tokens, cache_read_input_tokens,
        cache_creation_input_tokens, service_tier, …
```

So the four things the current pipeline cannot show — reasoning, prose, the tool
call with its arguments, the tool result — are all present, timestamped, ordered,
and never lost to a poll interval.

### Why the CLI flag route is closed

`claude --help`: `--output-format <format>` is annotated **"(only works with
--print)"**, and `--print` is a one-shot non-interactive run. Same for
`--include-partial-messages`, `--include-hook-events`, `--forward-subagent-text`,
`--fallback-model`, `--max-budget-usd`. A helyx session is interactive and holds
the channel for its lifetime, so none of these can be added to it.

This corrects the initial reading of the problem, which assumed a flag on
`run-cli.sh` and therefore a restart of every session. Neither is needed.

### Plumbing that already exists

| What | Where | Note |
|---|---|---|
| `~/.claude` inside the container | `docker-compose.yml` volumes | mounted at `/host-claude-config` |
| Path to it | `HOST_CLAUDE_CONFIG` env | already `/host-claude-config` |
| Which directory a session belongs to | `sessions.project_path` | written at session start |
| Project path known to the CLI | `run-cli.sh:22` `HELYX_PROJECT_PATH` | → `X-Helyx-Project` header |

Nothing new has to be mounted, passed or stored.

### The slug is not worth deriving

`~/.claude/projects/` encodes the working directory into a directory name, and
the rule is Claude Code's, undocumented, and already visibly irregular:

```
/home/altsay/bots/helyx        → -home-altsay-bots-helyx
/tmp/claude-1000/-home-…-proxy → -tmp-claude-1000--home-…-proxy   (doubled dash)
```

Reproducing that by string substitution is a guess that breaks silently on the
next path shape. Every entry in the file carries its own `cwd`, so the file can
be asked directly what directory it belongs to. Resolution is a directory scan
plus one line read per candidate — self-verifying, and immune to the encoding
changing.

### Existing code this must not break

`channel/status.ts` reads the monitor's output with three separate regexes that
all key on the current vocabulary:

- `accumulateTurnActivity` (l. 788) — counts `● ` lines, extracts filenames from
  `● Read|Write|Edit|Create: <path>`;
- `accumulateStats` (l. 812) — `Editing:` / `● Edit|Write:` and
  `Added N lines, removed N lines`;
- `utils/status-format.ts:scrapeTokenInfo` — `↓ <n> tokens`;
- `detectPhase` (l. 124) — the last `● ` line decides the phase emoji.

The transcript-derived lines must therefore keep speaking that vocabulary. This
is a constraint on the new code, not an invitation to rewrite the old.

### Relevant memory

`duplicated-knowledge-diverges` applies directly: `pane-parse.ts` exists because
the same parser had already been written twice and drifted three ways. The new
reader must not become a third copy of "what a tool call looks like" — the shared
vocabulary lives in one module and both readers use it.

### Dead code found

`utils/stream-json-parser.ts` (164 lines, `parseStreamEvent`, `formatToolStatus`,
`formatToolResult`) has **no runtime consumer** — the only references are docs,
health baselines and old gdctx logs. It parses the `stream-json` wire format
(`system`/`assistant`/`user`/`result`), which overlaps the transcript format on
`assistant`/`user` but not on `result`. Reusable in part; not usable as-is.
