# Project Memory

Version: 0.1.0

## Purpose

Long-term project memory: lessons learned, decisions, constraints, known
mistakes, historical context, and reusable patterns. Markdown is the source of
truth; `gd-metapro memory index` builds a searchable local index.

## Entry Types

- `lesson` (`lessons/`)
- `decision` (`decisions/`)
- `constraint` (`constraints/`)
- `known-mistake` (`known-mistakes/`)
- `historical-context` (`historical-context/`)
- `pattern` (`patterns/`)
- `task-note` (`task-notes/`)
- `review-note` (`review-notes/`)
- `incident` (`incidents/`)
- `migration-note` (`migration-notes/`)
- `integration-note` (`integration-notes/`)

## Usage

```bash
gd-metapro memory new lesson --title "<title>"
gd-metapro memory index
gd-metapro memory search "<query>" --status accepted
```

Only `accepted` entries influence skills. `draft` entries are advisory.
