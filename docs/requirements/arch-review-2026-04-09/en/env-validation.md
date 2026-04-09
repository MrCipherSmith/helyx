# PRD: Environment Variable Validation (Zod)

**Date:** 2026-04-09  
**Status:** Ready to implement  
**Priority:** High  
**Effort:** S  

---

## Overview

`config.ts` reads environment variables with raw `process.env` access and no runtime validation. Required variables are asserted with TypeScript's non-null assertion (`!`) which produces no runtime error when the value is undefined. Optional numeric variables use `Number()` which silently returns `NaN`. This PRD introduces a Zod schema that validates all env vars at startup and fails immediately with a human-readable error listing every misconfigured variable.

---

## Problem

**File:** `config.ts`, lines 1–56

### Required variables with no runtime check

```ts
TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN!,
DATABASE_URL: process.env.DATABASE_URL!,
```

The TypeScript `!` non-null assertion is compile-time only. If `TELEGRAM_BOT_TOKEN` is absent at runtime, `CONFIG.TELEGRAM_BOT_TOKEN` is `undefined`. grammY's `Bot` constructor receives `undefined` and throws deep in the HTTP client — the error message says nothing about the env var.

### Numeric coercion with no bounds or NaN check

```ts
PORT: Number(process.env.PORT ?? "3847"),
SHORT_TERM_WINDOW: Number(process.env.SHORT_TERM_WINDOW ?? "20"),
IDLE_TIMEOUT_MS: Number(process.env.IDLE_TIMEOUT_MS ?? "900000"),
ARCHIVE_TTL_DAYS: Number(process.env.ARCHIVE_TTL_DAYS ?? "30") || 30,
```

If `PORT=abc` is set, `Number("abc")` is `NaN`. The server binds on `NaN` and silently uses port 0. Only `ARCHIVE_TTL_DAYS` has a `|| 30` fallback — the rest have no protection.

### Unconstrained enum with a cast

```ts
TELEGRAM_TRANSPORT: (process.env.TELEGRAM_TRANSPORT ?? "polling") as "polling" | "webhook",
```

If `TELEGRAM_TRANSPORT=webhok` (typo), the cast silently passes an invalid string.

### Scattered raw env reads outside config.ts

- `channel.ts:41–45,78–79,181,243` — `DATABASE_URL`, `OLLAMA_URL`, `EMBEDDING_MODEL`, `BOT_API_URL`, `CHANNEL_SOURCE`, `IDLE_TIMEOUT_MS`, `HOME`
- `mcp/dashboard-api.ts:18,74,638` — `HOST_HOME`, `SECURE_COOKIES`, `HOST_CLAUDE_CONFIG`
- `utils/transcribe.ts:3–4` — `GROQ_API_KEY`, `WHISPER_URL`
- `utils/files.ts:5–16` — `DOWNLOADS_DIR`, `HOME`, `HOST_DOWNLOADS_DIR`
- `dashboard/auth.ts:7–8` — `JWT_SECRET`
- `bot/commands/admin.ts:143,152,161,355` — `OLLAMA_URL`, `ANTHROPIC_API_KEY`, `PORT`, `KNOWLEDGE_BASE`

None of these are validated. A missing `DOWNLOADS_DIR` causes a runtime crash; a missing `GROQ_API_KEY` is expected (optional), but there is no distinction enforced.

---

## Solution

Replace `config.ts`'s manual property-by-property construction with a Zod schema. `channel.ts` gets a parallel lightweight inline schema for the vars it uses (it runs as a separate process and cannot import `config.ts`).

---

## User Stories

1. **As an operator**, I want a clear error message listing every missing or invalid env var at startup, so I can fix configuration in one pass rather than chasing successive crashes.
2. **As a developer**, I want TypeScript types derived from the Zod schema, so that adding a new env var automatically gives me a typed `CONFIG` property.
3. **As a developer**, I want `channel.ts` to fail fast with a clear message if `DATABASE_URL` is absent.

---

## Acceptance Criteria

- [ ] `config.ts` uses a Zod schema to parse all env vars; raw `process.env.*` reads removed from the config object literal
- [ ] If any required variable is missing or invalid, the process prints all errors and exits with code 1 before any async code runs
- [ ] `TELEGRAM_BOT_TOKEN` and `DATABASE_URL` absence produce clear error messages
- [ ] `PORT`, `SHORT_TERM_WINDOW`, `IDLE_TIMEOUT_MS`, `ARCHIVE_TTL_DAYS`, `MAX_TOKENS` coerced to integers with `z.coerce.number().int().positive()`
- [ ] `TELEGRAM_TRANSPORT` validated against enum `["polling", "webhook"]`, rejects any other value
- [ ] `MEMORY_SIMILARITY_THRESHOLD` validated as float between 0 and 1
- [ ] `channel.ts` has a minimal inline schema validating its env reads at process start
- [ ] Exported `CONFIG` type is inferred from Zod schema (`z.infer<typeof EnvSchema>`), not hand-written
- [ ] `zod` is already a dependency (confirmed: `channel.ts` imports it); no new package needed

---

## Technical Approach

### `config.ts` — Zod schema

```ts
import { z } from "zod";

const EnvSchema = z.object({
  // Required
  TELEGRAM_BOT_TOKEN: z.string().min(1, "TELEGRAM_BOT_TOKEN is required"),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Telegram transport
  TELEGRAM_TRANSPORT: z.enum(["polling", "webhook"]).default("polling"),
  TELEGRAM_WEBHOOK_URL: z.string().default(""),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(""),
  TELEGRAM_WEBHOOK_PATH: z.string().default("/telegram/webhook"),

  // Access control
  ALLOWED_USERS: z.string().default("").transform((s) =>
    s.split(",").map(Number).filter(Boolean)
  ),
  ALLOW_ALL_USERS: z.string().optional().transform((s) => s === "true"),

  // LLM providers
  ANTHROPIC_API_KEY: z.string().default(""),
  CLAUDE_MODEL: z.string().default("claude-sonnet-4-20250514"),
  MAX_TOKENS: z.coerce.number().int().positive().default(8192),
  GOOGLE_AI_API_KEY: z.string().default(""),
  GOOGLE_AI_MODEL: z.string().default("gemma-4-31b-it"),
  OPENROUTER_API_KEY: z.string().default(""),
  OPENROUTER_MODEL: z.string().default("qwen/qwen3-235b-a22b:free"),
  OPENROUTER_BASE_URL: z.string().default("https://openrouter.ai/api/v1"),

  // Ollama
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  OLLAMA_CHAT_MODEL: z.string().default("qwen3:8b"),
  EMBEDDING_MODEL: z.string().default("nomic-embed-text"),

  // Server
  PORT: z.coerce.number().int().min(1).max(65535).default(3847),
  SHORT_TERM_WINDOW: z.coerce.number().int().positive().default(20),
  IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  ARCHIVE_TTL_DAYS: z.coerce.number().int().positive().default(30),

  // Memory
  MEMORY_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0.35),
  MEMORY_RECONCILE_TOP_K: z.coerce.number().int().positive().default(5),
  MEMORY_TTL_FACT_DAYS: z.coerce.number().int().min(0).default(90),
  MEMORY_TTL_SUMMARY_DAYS: z.coerce.number().int().min(0).default(60),
  MEMORY_TTL_DECISION_DAYS: z.coerce.number().int().min(0).default(180),
  MEMORY_TTL_NOTE_DAYS: z.coerce.number().int().min(0).default(30),
  MEMORY_TTL_PROJECT_CONTEXT_DAYS: z.coerce.number().int().min(0).default(180),

  // Voice
  GROQ_API_KEY: z.string().default(""),
  WHISPER_URL: z.string().default("http://localhost:9000"),

  // Security / paths
  JWT_SECRET: z.string().optional(),
  SECURE_COOKIES: z.string().optional(),
  DOWNLOADS_DIR: z.string().default("/app/downloads"),
  HOST_DOWNLOADS_DIR: z.string().optional(),
  HOST_CLAUDE_CONFIG: z.string().default("/host-claude-config"),
  HOST_PROJECTS_DIR: z.string().optional(),
  KNOWLEDGE_BASE: z.string().optional(),
});

const result = EnvSchema.safeParse(process.env);
if (!result.success) {
  console.error("[config] Invalid environment configuration:");
  for (const issue of result.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

export const CONFIG = result.data;
export type Config = typeof CONFIG;
```

### `channel.ts` inline schema

`channel.ts` runs as a separate stdio process and cannot import `config.ts`. Add minimal inline schema replacing the raw `process.env` reads at lines 41–50:

```ts
import { z } from "zod"; // already imported

const ChannelEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  OLLAMA_URL: z.string().default("http://localhost:11434"),
  EMBEDDING_MODEL: z.string().default("nomic-embed-text"),
  BOT_API_URL: z.string().default("http://localhost:3847"),
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  CHANNEL_SOURCE: z.enum(["remote", "local"]).optional(),
  IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(900_000),
  HOME: z.string().default("/root"),
});

const channelEnv = ChannelEnvSchema.safeParse(process.env);
if (!channelEnv.success) {
  for (const issue of channelEnv.error.issues) {
    process.stderr.write(`[channel] config error — ${issue.path.join(".")}: ${issue.message}\n`);
  }
  process.exit(1);
}
const ENV = channelEnv.data;
```

Then replace `process.env.DATABASE_URL!` → `ENV.DATABASE_URL`, `process.env.TELEGRAM_BOT_TOKEN` → `ENV.TELEGRAM_BOT_TOKEN`, etc.

### Follow-up: migrate scattered reads

For files running in the main bot process (`utils/transcribe.ts`, `utils/files.ts`, `dashboard/auth.ts`, `mcp/dashboard-api.ts`, `bot/commands/admin.ts`) — migrate them to read from `CONFIG` in a follow-up PR. All necessary fields are already in the schema above.

---

## Files

**Modified:**
- `config.ts` — replace manual literal with Zod schema
- `channel.ts` — inline `ChannelEnvSchema` at lines 41–50; replace `process.env.*` reads with `ENV.*`

**Follow-up (separate PRs):**
- `utils/transcribe.ts`, `utils/files.ts`, `dashboard/auth.ts`, `mcp/dashboard-api.ts`, `bot/commands/admin.ts` — migrate to `CONFIG.*`

---

## Out of Scope

- Validating env vars in `scripts/` or `tests/`
- Hot-reloading config on env changes
- Secrets management integration (Vault, AWS Secrets Manager)

---

## Dependencies

- `zod` already installed — no new packages
- `security-defaults` PRD adds `ALLOW_ALL_USERS` and `HOST_PROJECTS_DIR` — include both in the schema so the two PRDs can be implemented together

---

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Zod schema rejects a valid production env var due to overly strict validation | Low | Test against production `.env` before deploying; use `z.string()` not `z.string().url()` for optional URLs |
| `OPENROUTER_API_KEY` alias (`OPENAI_API_KEY`) not preserved | Low | Add transform that falls back to `process.env.OPENAI_API_KEY` |
| `channel.ts` inline schema uses different Zod version than main process | Very Low | Same `zod` package, already imported in `channel.ts` |
