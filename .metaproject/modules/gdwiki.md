# gdwiki

Version: 0.1.0

## Purpose

Project knowledge base from business logic to implementation.

## Commands

- `gd-metapro wiki status`
- `gd-metapro wiki new <type> <slug> --title "<title>"`
- `gd-metapro wiki collect [--force] [--limit <n>]`
- `gd-metapro wiki index`
- `gd-metapro wiki check-links`
- `gd-metapro wiki validate`

## Page Types

- `architecture` (`wiki/architecture/`) - system or module architecture
- `domain-model` (`wiki/domain-models/`) - entities, invariants, relationships
- `business-rule` (`wiki/business-rules/`) - business constraints and decisions
- `user-scenario` (`wiki/user-scenarios/`) - user workflows and expected outcomes
- `component` (`wiki/components/`) - UI/component behavior and ownership
- `service` (`wiki/services/`) - backend/service responsibility and APIs
- `integration` (`wiki/integrations/`) - external systems and contracts
- `decision` (`wiki/decisions/`) - known decisions and ADR-like records

## Data

- `wiki/index.md`
- `data/gdwiki/link-check/latest.md`

## Entry

- `wiki/index.md`

## Skills

- `skills/gdwiki/`
