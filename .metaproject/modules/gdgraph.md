# gdgraph

## Purpose

Builds code graph, symbol graph, dependency map, and affected context.

Current MVP builds a file dependency graph plus imported asset nodes. Generated
frontend/static outputs are skipped by default.

## Commands

- `keryx gdgraph build`
- `keryx gdgraph find "<terms>"` — find files/symbols by concept (seed search)
- `keryx gdgraph symbol "<name>" [--impact [--depth N]]` — definition + callers + callees; `--impact` = transitive-caller blast radius (symbol layer)
- `keryx gdgraph path "<A>" "<B>"` — shortest connection between two files/symbols
- `keryx gdgraph affected <file-or-symbol>` — blast radius
- `keryx gdgraph query cycles | orphans`
- `keryx gdgraph symbols <enable|disable|status>` — opt-in tree-sitter symbol layer

## Freshness & Refresh

The graph is a snapshot of the last `keryx gdgraph build`, not a live view of the working tree. A
graph answer computed after the file set moved is wrong, and nothing in the answer says so.

What invalidates it:

- a source file added, deleted, renamed or moved — the node set is stale, and `find`/`orphans`/
  `affected` silently answer from the old one;
- an import added or removed — the edge set is stale, so blast radius under-reports;
- an edit inside a file with unchanged imports — file-level graph unaffected; the opt-in symbol
  layer (`symbol`, `path` def/call data) IS stale, because signatures and call sites moved.

How staleness is observed:

```bash
keryx gdgraph context   # last line: "freshness: working tree clean"
                        # or "freshness: N uncommitted code file(s) may not be reflected"
```

That line counts uncommitted code files against `HEAD`; it is a heuristic, not a build ledger. It
cannot see committed-but-not-rebuilt changes, so the post-commit hook covers that half.

How it is repaired:

```bash
keryx gdgraph build
```

Agent rule: do not rebuild per question — the graph is meant to be read many times per build. Do
rebuild before relying on a graph answer when you added, renamed, deleted or moved files in this
session, when the freshness line reports uncommitted code files, or when graph storage is missing.
When you cannot rebuild, say the graph predates your changes instead of quoting it as current.

Automatic refresh: the optional Git `post-commit` hook rebuilds the graph after a commit that
touched graph-relevant paths (see `hooks/README.md`). It never blocks the commit, and
`KERYX_GDGRAPH_HOOK_REBUILD=0` turns it back into a printed reminder. In a project that versions
`data/gdgraph/artifacts/`, a rebuild leaves those files modified after the commit.

## Data

- `data/gdgraph/artifacts/summary.md`
- `data/gdgraph/artifacts/module-map.json`
- `data/gdgraph/storage/nodes.jsonl`
- `data/gdgraph/storage/edges.jsonl`
- `data/gdgraph/artifacts/summary.md`

## Skills

- `skills/gdgraph/`

## Frontend Defaults

- skips `storybook-static`, `public`, `.docusaurus`, `.next`, `out`, `dist`, `build`, `coverage`, and `generated`;
- resolves imported CSS, JSON, SVG, handlebars/raw templates, images and fonts as asset nodes;
- reports source files, asset nodes, import resolution, skipped directories, top modules, and unresolved imports by type.
