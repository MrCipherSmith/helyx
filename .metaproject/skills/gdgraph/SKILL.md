---
name: gdgraph
description: Use by default for project navigation and file discovery before broad raw search, especially when the user asks where something is, what files are related, what might be affected, or needs implementation, review, refactoring, debugging, architecture, dependency, module relationship, import cycle, or orphan-file context.
---

# gdgraph Skill

Use this skill by default for project navigation and file discovery. The user does not need to explicitly ask for graph usage.

When command output, search results, diff, logs, or large file reads may be long, pair this with `skills/gdctx/SKILL.md` so graph narrows the file set and gdctx compresses the output.

Run gdgraph before raw file search when the task involves finding relevant files, understanding project structure, implementation, review, refactoring, debugging, code understanding, impact analysis, architecture, dependencies, or navigation. A "targeted" `rg` does not exempt you: any text, symbol, or pattern search over project code is a search step and goes through the routing layer, not a bare `rg`/`grep`.

Skip gdgraph only when the request is clearly unrelated to project files, asks for a single known file's literal contents, or when gdgraph is unavailable. Skipping gdgraph is NOT permission to run raw `rg`: when the graph cannot seed the first hop (unknown symbol, no known file), do the text search with `keryx ctx rg "<pattern>"`, then feed the seed file back into `keryx gdgraph affected <file>`. Raw `rg`/`grep` is a last resort only, and only with a stated reason.

## Trigger Examples

- "Добавь обработку ошибки в init."
- "Проверь этот модуль."
- "Почему этот импорт ломается?"
- "Где лучше изменить эту логику?"
- "Где лежит логика инициализации?"
- "Какие файлы связаны с модулем gdgraph?"
- "Найди, где описаны rules/skills."
- "Что затронет изменение этого файла?"
- "Где используется этот модуль?"
- "Как связаны эти части кода?"
- "Есть ли циклы импортов?"
- "С чего начать читать этот модуль?"
- "Проанализируй архитектуру этой области."

## Workflow

1. Check whether `.metaproject/modules/gdgraph.md` exists.
2. If the task requires finding relevant project files or understanding relationships, use graph context before any `rg` or reading many files. When you do need a text/symbol search, run it as `keryx ctx rg`, not raw `rg`.
3. Do not rebuild the graph on every user question. Prefer existing graph storage and curated artifacts.
4. Run build only when graph storage is missing, obviously stale, or the user explicitly asks to refresh it:

```bash
keryx gdgraph build
```

5. Choose the graph command:

- Find files/symbols by concept (unknown location — use this instead of a raw `rg` for a seed):

```bash
keryx gdgraph find "<terms>"
```

- Known file path or changed file (blast radius). Accepts a symbol name too:

```bash
keryx gdgraph affected <file-or-symbol>
```

- Where is a symbol defined / who calls it (needs the symbol layer). Add
  `--impact [--depth N]` for the transitive-caller blast radius of a symbol:

```bash
keryx gdgraph symbol "<name>"
keryx gdgraph symbol "<name>" --impact
```

- How are two files/symbols connected:

```bash
keryx gdgraph path "<A>" "<B>"
```

- Dependency cycle / orphan questions:

```bash
keryx gdgraph query cycles
keryx gdgraph query orphans
```

Note: `gdgraph query` does NOT do natural-language search — use `find`. The
symbol layer (`symbol`/`path` def+call data) is opt-in: `keryx gdgraph symbols
enable` then `keryx gdgraph build` (needs the `web-tree-sitter` dep + grammars;
degrades to file-level otherwise).

6. Use graph output to select the smallest relevant file set.
7. Read those files directly and verify any conclusion against source code.
8. If gdgraph is unavailable or cannot answer the question, state that graph context is unavailable and continue with targeted search.

## Refresh Policy

Graph refresh should happen through one of these paths:

- user or agent explicitly runs `keryx gdgraph build`;
- Git `post-commit` hook refreshes graph after relevant file changes;
- graph storage is missing and the task needs graph context.

## Always-on orientation (optional)

Graph usage is advisory by default. Unlike a raw `rg` (which the gdctx guard can
deterministically re-route), a broad search or deep read is not reliably a
violation — so the enforcement analogue here is AVAILABILITY, not blocking:

```bash
keryx orient install-hook [--runtime <id|all>]   # inject graph map + wiki index at turn start
keryx gdgraph context                            # the graph half of that orientation
```

The injector adds a compact, freshness-aware code-graph map + wiki index to the
agent's context each turn, so the graph is always in front of you before you
reach for broad search. Supported where the harness has a context-injection hook
(claude, codex, cursor); Windsurf/Zed have none — use their rules/memories.

## Reporting

When answering a non-trivial navigation, debugging, review, or investigation task, include a routing audit. It is not optional; an omitted layer must be justified, not silently skipped:

- `graph_used`: commands run, or `unavailable`/`not-relevant` with the reason;
- `ctx_used`: `keryx ctx` commands run (search/read/diff), or the reason none were;
- `raw_rg_used`: `yes`/`no` — if `yes`, why the routing layer could not cover it.

Graph output is navigation context, not proof. Verify behavior in actual code before making claims.
