# Every MCP tool call and the Stop hook enter through an untested door

Status: formalized
Source: package `docs/requirements/io-layer-coverage-2026-08-05` (C4)

## Problem

`mcp/server.ts` is the door every MCP tool call, every Claude Code hook and —
in webhook mode — every Telegram update comes through. Nothing tests it.

Its request router is an anonymous arrow passed to `createServer`, and the only
way in from outside is `startMcpHttpServer`, which binds a fixed port and can
call `process.exit(1)`. So the routes cannot be reached from a test at all: not
the ones that decide whether a caller is local, not the shared-secret gate in
front of `/api/hooks/ask-question`, and not the traversal guard on the
transcript path the Stop hook is handed.

Those are authorization decisions. A change that widened any of them would be
invisible until someone on the Docker network — or beyond it — used it.

This flow was blocked from 2026-08-05 18:35 until the maintainer chose the
extraction over binding a port in tests.

## Expected Outcome

- The router is reachable by name, without a socket, a port or a process exit.
- The decisions that say yes or no to a caller are pinned by tests: local vs
  not, the hook token, the transcript path, and what an unknown route gets.

## Out of Scope

- The routes' happy paths, which write to the database or start background
  work. They need a seam of their own; this flow buys the authorization
  boundary and says so rather than pretending to cover the file.
- The MCP transport session lifecycle.
