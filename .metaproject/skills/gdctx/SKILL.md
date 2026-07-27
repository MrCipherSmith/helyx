---
name: gdctx
description: Use for commands, search, diff, test logs, lint/build output, and large file reads that can produce long output; prefer compact gd-metapro ctx output before loading raw command output into agent context.
---

# gdctx Skill

Use this skill by default when a task needs command output, search results, git diff/status, test logs, lint/build output, or large file reads that may produce more context than the agent should load directly. The user does not need to explicitly ask for gdctx usage.

## Workflow

1. Check whether `.metaproject/modules/gdctx.md` exists.
2. For potentially long output, prefer `gd-metapro ctx ...` over raw shell output by default.
3. For project navigation or file relationship questions, use gdgraph first when available, then use gdctx for compact command/file output.
4. Treat gdctx summaries as navigation context. Verify important claims against source files before editing or reporting.
5. Use raw output only when the compact summary is insufficient.

## Commands

```bash
gd-metapro ctx status
gd-metapro ctx diff
gd-metapro ctx rg "<pattern>"
gd-metapro ctx read <file> --mode outline
gd-metapro ctx read <file> --mode compact
gd-metapro ctx run -- <command...>
gd-metapro ctx show latest
```

## Skip When

- The command output is already tiny and exact raw output is more useful.
- The user explicitly asks for literal full file contents.
- `gd-metapro ctx` is unavailable.

## Reporting

When gdctx is used, mention the commands run and whether raw output was saved.
