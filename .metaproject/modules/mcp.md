# MCP Module

Version: 0.1.0
Type: module
Status: active

## Summary

Exposes read-only Metaproject services (code graph, security, flow status,
memory, health, wiki, standard) over the Model Context Protocol (MCP). A thin
protocol adapter — it defines no new module logic.

## Commands

- `keryx mcp serve` — stdio JSON-RPC MCP server (default transport).
- `keryx mcp serve --http` — isolated HTTP/SSE opt-in (localhost only;
  requires `http.enabled=true` in this module's manifest entry).
- `keryx mcp serve --cwd <project-root>` — expose a specific project,
  independent of the MCP client's launch directory.
- `keryx mcp install --runtime <cursor|claude|opencode|vscode|generic|all> [--dry-run]` —
  wire this project into an editor/agent: writes a project-local client
  config (cursor → `.cursor/mcp.json`, claude → `.mcp.json`, opencode →
  `opencode.json`, vscode → `.vscode/mcp.json`) and sets
  `modules.mcp.enabled=true`. `--dry-run` prints the change without
  writing anything. This is the command to run when a user asks to
  "connect" or "enable" MCP for this project — it is the full, real setup
  step; hand-editing a client config file directly is unnecessary and skips
  setting `modules.mcp.enabled`. `all` expands to cursor + claude +
  opencode; `vscode` is opt-in only (not bundled into `all`) — request it
  explicitly with `--runtime vscode`.
- `keryx mcp uninstall --runtime <cursor|claude|opencode|vscode|generic|all>` —
  remove the managed client config again.
- **codex CLI**: not a `--runtime` here — codex's client config is a single
  GLOBAL `~/.codex/config.toml`, not a project-local file, and it already
  ships its own safe, native installer for it. Run
  `codex mcp add keryx -- keryx mcp serve --cwd <project-root>` once
  (verified live: codex successfully discovers and calls this server's
  tools headlessly with `codex exec --approve-for-me`); `codex mcp remove
  keryx` to undo. `modules.mcp.enabled=true` still needs
  `keryx mcp install --runtime generic` (or any other runtime) run once,
  since codex's own installer has no notion of the keryx manifest.

## Notes

- Requires the optional `@modelcontextprotocol/sdk`. Disabled by default.
- Every tool result is routed through the security `redactRaw` seam before
  transport.
- Tool/resource exposure is filtered by the manifest (`expose.modules`); a
  disabled module is hidden from `tools/list` and `resources/list`.
