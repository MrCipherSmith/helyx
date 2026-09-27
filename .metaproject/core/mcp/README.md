# MCP Core

Configuration for the `mcp` module lives in `mcp.config.json` (deep-merged over
built-in defaults). Transports are stdio (default) and an opt-in HTTP/SSE bridge.
`mcp install` writes client configs with `--cwd <project-root>` so tools and
resources resolve the intended project even when the editor launches the server
from another directory.

See `.metaproject/modules/mcp.md` for the command surface.
