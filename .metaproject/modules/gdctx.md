# gdctx

## Purpose

Runs common project context commands with token-aware filtering and stores raw output separately.

## Commands

- `keryx ctx status`
- `keryx ctx diff`
- `keryx ctx rg "<pattern>"`
- `keryx ctx read <file>`
- `keryx ctx run -- <command...>`
- `keryx ctx show latest`
- `keryx ctx install-hook` / `keryx ctx uninstall-hook` (opt-in routing guard)

## Data

- `data/gdctx/artifacts/latest.md`
- `data/gdctx/raw/`
- `data/gdctx/queries/`

## Config

- `gdctx.config.json`

## Skills

- `skills/gdctx/`
