# memory

Version: 0.2.0

## Purpose

Long-term, typed project memory with deterministic ranked search and a
gdskills learning signal.

## Commands

- `keryx memory new <type> --title "<title>"`
- `keryx memory index [--embeddings]` (optional disposable catalog/cache)
- `keryx memory search "<query>" [--module <m>] [--entity <e>] [--status <s>] [--limit <n>] [--as-of <YYYY-MM-DD>] [--class <class>] [--semantic] [--save-report]` (pure by default)
- `keryx memory transition <path> --to <draft|accepted|conflict|deprecated> [--reason <text>]`
- `keryx memory supersede <old-path> --by <new-path> [--date <YYYY-MM-DD>]`
- `keryx memory ingest --from-<source> <path>`
- `keryx memory check`

## Config

- `memory.config.json`

## Data

- `memory/index.md`
- `data/memory/index/index.json` (disposable generated catalog)
- `data/memory/embeddings/` (disposable optional cache)
- `runtime/memory/search/<run-id>/` (explicit reports only)

Search reads canonical Markdown directly and never consumes the generated
catalog or writes a legacy global `latest` report. Downstream migration from
legacy `data/memory/artifacts/latest.*` is advisory and never deletes files or
changes the Git index automatically.

## Skills

- `skills/memory/`
