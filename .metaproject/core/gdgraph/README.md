# gdgraph Core

Local gdgraph service layer installed by `gd-metapro init`.

Files:

- `cli.ts` - local runner used by `gd-metapro gdgraph ...`
- `build.ts` - builds file dependency graph
- `query.ts` - reads graph storage and answers built-in queries
- `types.ts` - local graph schema

Responsibilities:

- build file dependency graph;
- resolve local imported assets as graph asset nodes;
- skip generated/static frontend output by default;
- write graph storage to `.metaproject/data/gdgraph/storage`;
- write curated artifacts to `.metaproject/data/gdgraph/artifacts`;
- expose service functions for future CLI and MCP commands.
