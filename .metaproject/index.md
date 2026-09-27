# Metaproject Index

Routing pointers. Everything else is in [`routing.md`](routing.md) — read it only if what you need is not below.

| need | use |
|---|---|
| where is X, what depends on it, what breaks | `keryx gdgraph affected <file>` |
| search code | `keryx ctx rg "<pattern>" [path]` |
| run a command with long output | `keryx ctx run -- <cmd>` |
| architecture, domain, decisions, why | `wiki/index.md`, `keryx wiki ask` |
| past decisions, lessons, constraints | `keryx memory search "<query>"` |
| what tests to run, test context | `keryx test related <file>` |
| lint/type/test/quality status | `keryx health run` |
| current work state | `keryx flow status` |
| secrets, PII, prompt injection | `keryx security check-output` |
| implement, review, refactor, plan | `skills/catalog.md` |

- Code search goes through `keryx ctx rg`, never bare `rg`/`grep`.
- The graph answers from the last `keryx gdgraph build`, not the working tree. Rebuild after adding, renaming or moving files, or say the answer predates them.

Treat requests as intents; the user does not need to know these command names.
