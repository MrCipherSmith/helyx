# gdctx Core

Local gdctx service layer installed by `gd-metapro init`.

Responsibilities:

- run project context commands through `gd-metapro ctx ...`;
- preserve raw stdout/stderr under `.metaproject/data/gdctx/raw`;
- write compact curated summaries under `.metaproject/data/gdctx/artifacts`;
- use gdgraph artifacts for narrowing when graph context is available;
- expose a service layer for future CLI and MCP commands.

MVP note: executable gdctx scripts are added after the requirements/spec phase. This directory is reserved now so project-local overrides have a stable location.
