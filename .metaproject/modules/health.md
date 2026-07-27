# health

Version: 0.1.0

## Purpose

Aggregates code quality signals (lint, type, tests, coverage, dependency audit),
normalizes findings, computes project/module/file metrics, and produces a
deterministic quality gate report.

## Commands

- `gd-metapro health run [--strict] [--scope ...] [--source ...]`
- `gd-metapro health status`
- `gd-metapro health gate [--strict-warn]`
- `gd-metapro health sources`
- `gd-metapro health explain <file-or-module>`
- `gd-metapro health baseline update [--scope ...]`
- `gd-metapro health trend [--scope <scope-key>] [--limit <n>]`

## Config

- `health.config.json`

## Data

- `data/health/artifacts/latest.md`
- `data/health/artifacts/latest.json`
- `health/baselines/scores.json`

## Skills

- `skills/health/`
