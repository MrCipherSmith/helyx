---
name: memory
description: Use for durable project knowledge - past decisions, constraints, known mistakes, lessons, and patterns. Search memory before planning or implementing to avoid repeating mistakes; propose durable entries after tasks.
---

# memory Skill

Use this skill for long-term project experience: accepted decisions,
constraints, known mistakes, lessons, and reusable patterns.

## Workflow

1. Before planning/implementing, run `keryx memory search "<topic>" --status accepted`.
2. Read only the returned snippets, not the whole memory.
3. Respect accepted decisions/constraints; treat `draft`/`conflict` as advisory.
4. After a task/review, propose durable entries with `keryx memory new` or `ingest`.
5. Run `keryx memory check` before relying on cross-entry links.

## Commands

```bash
keryx memory search "<query>" --status accepted
keryx memory new lesson --title "<title>"
keryx memory ingest --from-review <path>
keryx memory check
```

## Notes

- Only `accepted` entries influence skills; `draft` are advisory.
- Markdown is the source of truth; never hand-edit generated indexes.
