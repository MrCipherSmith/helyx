---
name: gdgraph
description: Use by default for project navigation and file discovery before broad raw search, especially when the user asks where something is, what files are related, what might be affected, or needs implementation, review, refactoring, debugging, architecture, dependency, module relationship, import cycle, or orphan-file context.
---

# gdgraph Skill

Use this skill by default for project navigation and file discovery. The user does not need to explicitly ask for graph usage.

When command output, search results, diff, logs, or large file reads may be long, pair this with `skills/gdctx/SKILL.md` so graph narrows the file set and gdctx compresses the output.

Run gdgraph before broad raw file search when the task involves finding relevant files, understanding project structure, implementation, review, refactoring, debugging, code understanding, impact analysis, architecture, dependencies, or navigation.

Skip gdgraph only when the request is clearly unrelated to project files, asks for a single known file's literal contents, or when gdgraph is unavailable.

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
2. If the task requires finding relevant project files or understanding relationships, use graph context before broad `rg` or reading many files.
3. Do not rebuild the graph on every user question. Prefer existing graph storage and curated artifacts.
4. Run build only when graph storage is missing, obviously stale, or the user explicitly asks to refresh it:

```bash
gd-metapro gdgraph build
```

5. Choose the graph command:

- Known file path or changed file:

```bash
gd-metapro gdgraph affected <file>
```

- Dependency cycle question:

```bash
gd-metapro gdgraph query cycles
```

- Orphan/unreferenced module question:

```bash
gd-metapro gdgraph query orphans
```

6. Use graph output to select the smallest relevant file set.
7. Read those files directly and verify any conclusion against source code.
8. If gdgraph is unavailable or cannot answer the question, state that graph context is unavailable and continue with targeted search.

## Refresh Policy

Graph refresh should happen through one of these paths:

- user or agent explicitly runs `gd-metapro gdgraph build`;
- Git `post-commit` hook refreshes graph after relevant file changes;
- graph storage is missing and the task needs graph context.

## Reporting

When answering, include a short graph context note:

- `graph_context: used` with commands run;
- `graph_context: unavailable` with the reason.

Graph output is navigation context, not proof. Verify behavior in actual code before making claims.
