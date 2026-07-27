# gdgraph

## Purpose

Builds code graph, symbol graph, dependency map, and affected context.

Current MVP builds a file dependency graph plus imported asset nodes. Generated
frontend/static outputs are skipped by default.

## Commands

- `gd-metapro gdgraph build`
- `gd-metapro gdgraph query "<query>"`
- `gd-metapro gdgraph affected <target>`
- `gd-metapro gdgraph explain <target>`

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
