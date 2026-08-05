# Flow Journal

- 2026-08-05T18:34:30.303Z - flow created
- 2026-08-05T18:35:47.762Z - blocked: Reaching 60% of mcp/server.ts requires testing its routes, and the routes live inside an arrow function passed to createServer, which binds a fixed port that is already taken on this host by the container. Testing them means first extracting the handler into a named exported function — a refactor of the busiest entry point in the system, undertaken purely to make it testable. That is a decision for the maintainer, not a coverage chore, so this flow waits for it.
