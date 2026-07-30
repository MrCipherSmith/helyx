# health

Version: 0.1.0

## Purpose

Aggregates code quality signals (lint, type, tests, coverage, dependency audit),
normalizes findings, computes project/module/file metrics, and produces a
deterministic quality gate report.

## Commands

- `keryx health run [--strict] [--scope ...] [--source ...]`
- `keryx health status`
- `keryx health gate [--strict-warn]`
- `keryx health sources`
- `keryx health explain <file-or-module>`
- `keryx health baseline update [--scope ...]`
- `keryx health trend [--scope <scope-key>] [--limit <n>]`

## Config

- `health.config.json`

## Data

- `data/health/artifacts/latest.md`
- `data/health/artifacts/latest.json`
- `health/baselines/scores.json`

## Skills

- `skills/health/`
