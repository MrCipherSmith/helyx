// Reverse re-export shim. The canonical implementation moved to ../llm/client.ts.
// Existing imports of "../claude/client.ts" continue to work via this re-export.
export * from "../llm/client.ts";
