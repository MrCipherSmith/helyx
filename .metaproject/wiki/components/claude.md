# Module claude

Version: 1.0.0
Type: component
Status: enriched

## Summary

LLM interaction layer providing a unified multi-provider API client with streaming and non-streaming modes, automatic retry with exponential backoff, token usage tracking, and a prompt composer that assembles session context from short-term and long-term memory.

## Responsibility

Owns all LLM communication. Split into two files with clear separation of concerns:

- **`client.ts`** — LLM gateway that abstracts four providers (Anthropic SDK, Google AI via OpenAI-compatible proxy, OpenRouter/OpenAI-compatible, local Ollama) behind a single `streamResponse()`/`generateResponse()` interface. Handles retry with exponential backoff (3 attempts, 429/5xx only), strips reasoning tokens (`<think>...</think>`) from non-Anthropic providers, and automatically records API call statistics (timing, tokens, status) to the database.

- **`prompt.ts`** — Context assembler that builds the full prompt for each turn. Gathers session metadata via `SessionManager`, retrieves up to 5 relevant long-term memories via vector similarity search, fetches recent conversation history from short-term memory, and falls back to cross-session project history when the current conversation is thin (<3 messages). Returns `{ system, messages }` ready for the LLM client.

Provider priority: Anthropic > Google AI > OpenRouter > Ollama (based on available API keys).

## Public API

- `ContentBlock`
- `MessageParam`
- `StreamContext`
- `getProviderInfo`
- `streamResponse`
- `generateResponse`
- `summarizeConversation`
- `composePrompt`

## Key files

- `claude/client.ts` - imported by 12, imports 4
- `claude/prompt.ts` - imported by 3, imports 4

## Depends on

- `@anthropic-ai/sdk`
- `config.ts`
- `utils/stats.ts` (recordApiRequest)
- `memory/long-term.ts` (recall)
- `memory/short-term.ts` (getContext, getProjectHistory)
- `sessions/manager.ts` (sessionManager)

## Depended on by

- `memory/summarizer.ts`
- `bot/streaming.ts`
- `utils/curator.ts`

## Graph signals

- Files: 2
- Cross-module imports: 6

## Related Wiki

- [Wiki Index](../index.md)
- [Module adapters](../components/adapters.md)
- [Module memory](../components/memory.md)
- [Module sessions](../components/sessions.md)
- [Module bot](../components/bot.md)

## Changelog

- 1.0.0 - Created from code analysis.
