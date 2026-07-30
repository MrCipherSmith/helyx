---
name: gdctx
description: Use for commands, search, diff, test logs, lint/build output, and large file reads that can produce long output; prefer compact keryx ctx output before loading raw command output into agent context.
---

# gdctx Skill

Use this skill by default when a task needs command output, search results, git diff/status, test logs, lint/build output, or large file reads that may produce more context than the agent should load directly. The user does not need to explicitly ask for gdctx usage.

**Search rule (hard):** any text, symbol, or pattern search over project code goes through `keryx ctx rg "<pattern>"`, never a bare `rg`/`grep`. This holds even for a single "targeted" search and even when you skip gdgraph/gdwiki — `ctx rg` compresses the output while raw `rg` dumps it into context. Raw `rg`/`grep` is allowed only as a last resort when `keryx ctx rg` is unavailable or demonstrably cannot express the query, and the reason must be stated in the routing audit.

## Workflow

1. Check whether `.metaproject/modules/gdctx.md` exists.
2. For potentially long output, prefer `keryx ctx ...` over raw shell output by default.
3. For project navigation or file relationship questions, use gdgraph first when available, then use gdctx for compact command/file output.
4. Treat gdctx summaries as navigation context. Verify important claims against source files before editing or reporting.
5. Use raw output only when the compact summary is insufficient.

## Commands

```bash
keryx ctx status
keryx ctx diff
keryx ctx rg "<pattern>"
keryx ctx read <file> --mode outline
keryx ctx read <file> --mode compact
keryx ctx run -- <command...>
keryx ctx show latest
```

## Enforcement (optional)

The search rule above is advisory by default. To make it a hard gate, install the
routing guard — a pre-shell-execution hook for your agent harness:

```bash
keryx ctx install-hook                       # default: claude
keryx ctx install-hook --runtime all         # every supported harness
keryx ctx install-hook --runtime cursor,codex
keryx ctx uninstall-hook [--runtime <id|all>]
```

Supported harnesses: `claude`, `codex`, `cursor`, `windsurf` (verified),
`antigravity`, `opencode` (experimental — verify on a live install). Zed has no
scriptable pre-exec hook yet (use its static tool_permissions).

The guard blocks raw `rg`/`grep`/`cat`/`head`/`tail`/`git diff|log|show` (deny +
feedback) and points the agent to the `keryx ctx` equivalent. It is routing-only:
any other command passes through, so a generic output-compressing proxy can
coexist. When a raw command is genuinely required, append an escape marker with a
reason: `rg "<pcre>" # keryx:raw <why>`. The guard fails open on unparseable input.

## Skip When

- The command output is already tiny and exact raw output is more useful (a single-line status, a one-line command whose result you already know is short).
- The user explicitly asks for literal full file contents.
- `keryx ctx` is unavailable.

Note: "the output is already tiny" is a judgement about a specific known command, not a blanket exemption. A code search whose result size is unknown up front is not tiny by default — route it through `keryx ctx rg`.

## Reporting

When gdctx is used, mention the commands run and whether raw output was saved. For non-trivial tasks, report `ctx_used` and `raw_rg_used: yes/no` as part of the routing audit (see the gdgraph skill's Reporting section), justifying any raw `rg`/`grep`.
