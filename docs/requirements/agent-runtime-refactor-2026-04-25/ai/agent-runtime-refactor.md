# PRD: Helyx Agent Runtime Refactor

## Document Metadata

- Product: Helyx
- Document Type: AI-readable Product Requirements Document
- Status: Draft (updated 2026-04-24 — verified against codebase)
- Date: 2026-04-25
- Primary Goal: Refactor Helyx from a Claude/tmux-centric Telegram control panel into a provider-agnostic agent control plane with persistent, manageable, specialized agents.
- Target Readers: AI coding agents, architects, maintainers, implementation agents
- Source Repositories:
  - `https://github.com/MrCipherSmith/helyx`
  - `https://github.com/MrCipherSmith/heryx` pending access; unavailable during initial review

---

## 1. Executive Summary

Helyx currently acts as a Telegram and dashboard control surface for Claude Code sessions. It already contains strong foundations for a broader autonomous agent system: Telegram forum topics, project/session registry, PostgreSQL-backed queues, MCP tools, memory, approvals, tmux process management, health supervision, and a dashboard.

The main limitation is that several layers are still coupled to Claude Code and tmux:

- Runtime startup assumes `claude`.
- Session type assumes `cli_type = "claude"`.
- Model selection assumes Claude models.
- `tmux` is used as process manager, terminal UI, health source, and manual debug layer.
- Telegram commands trigger tmux-oriented project actions rather than declaring desired agent state.

This refactor introduces a generic agent runtime architecture:

```text
Telegram / Dashboard
  -> AgentManager
  -> desired_state in DB
  -> RuntimeManager reconcile loop
  -> RuntimeDriver: tmux | pty | process | docker
  -> AgentRuntimeAdapter: claude-code | codex-cli | gemini-cli | opencode | aider | standalone-llm
  -> agent_instances / sessions / memory / events
```

The first implementation must preserve existing Claude/tmux behavior while creating stable extension points for PTY-managed Claude sessions, Codex CLI, Gemini CLI, OpenCode, Aider, and local LLM workers.

---

## 2. Problem Statement

### Current Problems

1. Telegram starts and stops tmux sessions indirectly through `admin_commands`, `admin-daemon`, and shell commands.
2. tmux is overloaded with too many responsibilities:
   - process lifecycle
   - manual terminal access
   - progress observation
   - input injection
   - recovery signal
3. tmux window state can drift from database session state.
4. Claude-specific assumptions are spread across adapters, sessions, CLI scripts, commands, and documentation.
5. Adding non-Claude agents requires duplicating behavior or bending existing Claude abstractions.
6. Long-running specialized sub-agents are not first-class entities.
7. Orchestration is skill-like or manual, not represented as persistent tasks and agent assignments.

### Desired Outcome

Helyx should manage agents, not terminal windows.

Telegram and dashboard controls should mutate declarative desired state:

```text
agent_instance.desired_state = "running" | "stopped" | "paused"
```

A runtime reconciler should converge actual state toward desired state:

```text
desired=running, actual=stopped -> start
desired=running, heartbeat stale -> restart or escalate
desired=stopped, actual=running -> stop
task stuck -> interrupt, retry, reassign, or escalate
```

---

## 3. Goals

### G1. Decouple Helyx from Claude Code

Introduce runtime and provider abstractions that allow Claude Code to remain supported while enabling additional coding agents and LLM providers.

### G2. Decouple Helyx from tmux

Keep tmux as a compatibility runtime driver, but make it optional. Add architecture support for PTY, process, and Docker drivers.

### G3. Introduce Persistent Specialized Agents

Represent specialized agents as durable records with roles, runtime type, model/provider config, permissions, memory scope, and desired lifecycle state.

### G4. Introduce Agent Orchestration

Represent work as durable tasks that can be assigned, delegated, retried, reviewed, and summarized.

### G5. Preserve Existing UX

Existing forum topics, `/projects`, `/sessions`, Claude Code channel behavior, memory, permissions, and dashboard views must continue to work during migration.

---

## 4. Non-Goals

- Do not remove tmux in the first phase.
- Do not rewrite Telegram UX from scratch.
- Do not remove Claude Code support.
- Do not require Docker for all agents.
- Do not introduce multi-user isolation in this refactor unless needed for schema compatibility.
- Do not implement full marketplace/skill registry in this phase.
- Do not build a new product separate from Helyx.

---

## 5. Current Architecture Summary

Important current components:

- `main.ts`: starts bot, MCP HTTP server, migrations, cleanup.
- `bot/`: Telegram command and message layer.
- `bot/commands/tmux-actions.ts`: Telegram commands that directly execute tmux shell operations.
- `bot/commands/supervisor-actions.ts`: Telegram commands that interact with the supervisor process.
- `sessions/`: current session routing and lifecycle.
- `sessions/manager.ts`: session CRUD and upsert, hardcodes `cliType: "claude"` throughout.
- `sessions/router.ts`: routes incoming Telegram messages to the correct session. Phase 4 must update this to route to `agent_instances` instead.
- `sessions/state-machine.ts`: state machine for session lifecycle transitions. Phase 4 will introduce a parallel `AgentInstance.actualState` machine — reconciliation strategy required (see Phase 4 notes).
- `adapters/`: current CLI adapter registry, currently only Claude (`claude.ts`, `index.ts`, `types.ts`).
- `channel/`: stdio MCP channel adapter for Claude Code. Note: `channel.ts` also exists at project root as an entry point.
- `mcp/`: MCP HTTP server, tools, dashboard API.
- `memory/`: Postgres migrations, short-term context, long-term pgvector memory, summarization.
- `scripts/admin-daemon.ts`: host-side command executor, contains raw tmux shell commands for `proj_start`, `proj_stop`, `tmux_send_keys`.
- `scripts/run-cli.sh`: starts Claude Code in a tmux or terminal loop.
- `scripts/supervisor.ts`: health watchdog and recovery loops.
- `scripts/tmux-watchdog.ts`: separate tmux health watcher with direct tmux shell calls. Phase 2 must update alongside `admin-daemon.ts`.
- `services/project-service.ts`: project CRUD. `Project` interface has `tmux_session_name` field from the `projects` DB table. Phase 2 must decide fate of this column.
- `claude/client.ts`: **already multi-provider** — supports Anthropic, Google AI, OpenRouter, and Ollama via runtime provider detection from env vars. Phase 3 scope is therefore adding `model_profiles` routing layer on top of existing logic, not rewriting from scratch.

Current critical coupling points:

```text
adapters/types.ts            -> readonly type: "claude"
sessions/manager.ts          -> cliType: "claude" (hardcoded in 6+ locations)
sessions/state-machine.ts    -> session-scoped lifecycle; will conflict with AgentInstance.actualState
sessions/router.ts           -> routes to sessions, not agent instances
memory/db.ts                 -> cli_type DEFAULT 'claude'
scripts/run-cli.sh           -> hardcoded claude command
scripts/tmux-watchdog.ts     -> direct tmux shell commands, not abstracted
bot/commands/model.ts        -> hardcoded CLAUDE_MODELS array
bot/commands/tmux-actions.ts -> direct tmux operations from Telegram handlers
channel/*                    -> Claude channel protocol
admin-daemon.ts              -> raw proj_start/proj_stop/tmux_send_keys shell commands
services/project-service.ts  -> projects.tmux_session_name field
```

---

## 6. Target Architecture

### 6.1 High-Level Architecture

```text
User Interfaces
  - Telegram bot
  - Telegram forum topics
  - Dashboard / Mini App

Control Plane
  - AgentManager
  - TaskManager
  - RuntimeManager
  - Orchestrator
  - Supervisor / Reconciler

Persistence
  - agent_definitions
  - agent_instances
  - agent_tasks
  - agent_events
  - sessions
  - projects
  - memories
  - permission_requests

Runtime Drivers
  - tmux-driver
  - pty-driver
  - process-driver
  - docker-driver

Model Provider Layer
  - model_providers
  - model_profiles
  - provider-specific clients
  - fallback policies

Agent Runtime Adapters
  - claude-code-adapter
  - codex-cli-adapter
  - gemini-cli-adapter
  - opencode-adapter
  - aider-adapter
  - standalone-llm-adapter
```

### 6.1.1 Telegram Forum Topic Model

Telegram forum topics must be modeled as project rooms, not as agents.

```text
General topic
  -> global control plane
  -> project and agent lifecycle management
  -> monitoring, incidents, global task lists

Project topic
  -> workspace channel for one project
  -> may contain multiple agents assigned to the same project
  -> normal user messages route to the project's default agent
```

Example:

```text
Topic: Helyx
  project_id = helyx

Agents in this project:
  coder        claude-code / tmux       running
  planner      deepseek-chat / process  stopped
  reviewer     codex-cli / process      paused
  tester       process / shell          stopped
```

The topic is the room. Agents are participants with roles and runtime bindings.

### 6.2 Key Principle

Separate these concepts:

```text
Model Provider != Agent Runtime != Agent Role != Process Driver
```

Examples:

```text
Provider: Anthropic
Runtime: claude-code
Role: implementer
Driver: pty

Provider: OpenAI
Runtime: codex-cli
Role: reviewer
Driver: process

Provider: Ollama
Runtime: standalone-llm
Role: summarizer
Driver: process
```

### 6.3 Model Provider Layer

The model/provider layer must be independent from the agent runtime layer.

Current Helyx already has multi-provider standalone LLM support in the existing client implementation, but provider selection is global and environment-priority based. The refactor must support per-agent and per-task model selection.

Required conceptual flow:

```text
Agent role
  -> model_profile_id
  -> model provider
  -> normalized LLM client
  -> provider-specific API
```

Examples:

```text
coder
  runtime_type: claude-code
  runtime_driver: tmux
  model_profile: claude-code-sonnet

planner
  runtime_type: standalone-llm
  runtime_driver: process
  model_profile: deepseek-chat-direct

reviewer
  runtime_type: standalone-llm
  runtime_driver: process
  model_profile: openrouter-claude-sonnet

summarizer
  runtime_type: standalone-llm
  runtime_driver: process
  model_profile: ollama-qwen3-8b
```

Provider types:

```text
anthropic
openai
openai-compatible
openrouter
google-ai
ollama
custom
```

Important rule:

```text
Agents must reference model_profile_id, not raw model strings.
```

Rationale: the same model family may require different model IDs, headers, capabilities, pricing, and fallback behavior depending on provider.

---

## 7. Required Domain Model

### 7.1 AgentDefinition

Persistent definition of an agent role.

```ts
interface AgentDefinition {
  id: string;
  name: string;
  role:
    | "orchestrator"
    | "planner"
    | "implementer"
    | "reviewer"
    | "tester"
    | "release-manager"
    | "watchdog"
    | "researcher"
    | "custom";

  runtimeType:
    | "claude-code"
    | "codex-cli"
    | "gemini-cli"
    | "opencode"
    | "aider"
    | "standalone-llm";

  runtimeDriver:
    | "tmux"
    | "pty"
    | "process"
    | "docker";

  provider?: "anthropic" | "openai" | "openrouter" | "google-ai" | "ollama" | "custom";
  model?: string;
  modelProfileId?: string;
  systemPrompt: string;
  projectScope?: string[];
  toolsPolicy: ToolsPolicy;
  permissionsPolicy: PermissionsPolicy;
  memoryPolicy: MemoryPolicy;
  schedulePolicy?: SchedulePolicy;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

Implementation note:

`provider` and `model` may remain as backward-compatible denormalized fields, but new code should prefer `modelProfileId`.

### 7.1.1 Project Agent Routing

Each project may have multiple agents. One agent should be selected as the default target for ordinary messages in the project topic.

Add or derive:

```ts
interface ProjectAgentRouting {
  projectId: number;
  forumTopicId: number;
  defaultAgentInstanceId: string;
}
```

Routing rules:

```text
message_thread_id -> projects.forum_topic_id -> project_id

If text starts with or mentions @agent_name:
  route to matching project agent

Else if command is /orchestrate:
  route to project orchestrator

Else if command is /task and mentions an agent:
  create task assigned to that agent

Else:
  route to project.default_agent_instance_id
```

Agent names must be unique within a project.

### 7.2 AgentInstance

Live or desired runtime instance for an agent.

```ts
interface AgentInstance {
  id: string;
  definitionId: string;
  projectId?: number;
  sessionId?: number;

  desiredState: "running" | "stopped" | "paused";
  actualState:
    | "new"
    | "starting"
    | "running"
    | "idle"
    | "busy"
    | "waiting_approval"
    | "stuck"
    | "stopping"
    | "stopped"
    | "failed";

  runtimeDriver: "tmux" | "pty" | "process" | "docker";
  runtimeHandle: RuntimeHandle;

  heartbeatAt?: string;
  startedAt?: string;
  stoppedAt?: string;
  restartCount: number;
  lastSnapshot?: string;
  lastTaskId?: string;
  error?: string;
}
```

### 7.3 AgentTask

Durable unit of work assignable to one or more agents.

```ts
interface AgentTask {
  id: string;
  parentTaskId?: string;
  projectId?: number;
  createdBy: "telegram" | "dashboard" | "orchestrator" | "schedule" | "api";
  orchestratorAgentId?: string;
  assignedAgentId?: string;

  type:
    | "analyze"
    | "plan"
    | "implement"
    | "review"
    | "test"
    | "summarize"
    | "monitor"
    | "custom";

  status:
    | "queued"
    | "assigned"
    | "running"
    | "waiting_approval"
    | "blocked"
    | "completed"
    | "failed"
    | "cancelled";

  priority: number;
  input: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  createdAt: string;
  updatedAt: string;
}
```

### 7.4 RuntimeHandle

Driver-specific handle persisted in JSONB.

```ts
interface RuntimeHandle {
  driver: "tmux" | "pty" | "process" | "docker";
  pid?: number;
  tmuxSession?: string;
  tmuxWindow?: string;
  tmuxPane?: string;
  containerId?: string;
  logPath?: string;
  socketPath?: string;
  cwd: string;
}
```

### 7.5 ModelProvider

Provider account/endpoint configuration. Secrets must be referenced by env key, not stored directly in DB.

```ts
interface ModelProvider {
  id: string;
  type:
    | "anthropic"
    | "openai"
    | "openai-compatible"
    | "openrouter"
    | "google-ai"
    | "ollama"
    | "custom";
  displayName: string;
  baseUrl?: string;
  apiKeyRef?: string;
  defaultHeaders: Record<string, string>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### 7.6 ModelProfile

Reusable model configuration for agents and tasks.

```ts
interface ModelProfile {
  id: string;
  providerId: string;
  model: string;
  displayName: string;
  capabilities: {
    streaming?: boolean;
    tools?: boolean;
    vision?: boolean;
    jsonMode?: boolean;
    jsonSchema?: boolean;
    reasoning?: boolean;
    embeddings?: boolean;
    maxContextTokens?: number;
  };
  defaults: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    timeoutMs?: number;
  };
  fallbackProfileIds: string[];
  costHint: {
    inputPerMillion?: number;
    outputPerMillion?: number;
    currency?: string;
  };
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
```

### 7.7 Normalized LLM Client

Create or refactor into a normalized LLM client used by `standalone-llm-adapter`, summarization, memory reconciliation, planning, and orchestration.

```ts
interface LlmClient {
  generate(input: LlmGenerateInput): Promise<LlmResult>;
  stream(input: LlmGenerateInput): AsyncIterable<LlmStreamEvent>;
}

interface LlmGenerateInput {
  modelProfileId: string;
  messages: LlmMessage[];
  system?: string;
  tools?: LlmTool[];
  responseFormat?: "text" | "json" | "json_schema";
  temperature?: number;
  maxTokens?: number;
  metadata?: {
    agentId?: string;
    taskId?: string;
    projectId?: number;
    operation?: string;
  };
}

interface LlmResult {
  text: string;
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  provider: string;
  model: string;
  modelProfileId: string;
  finishReason?: string;
}
```

The client must normalize:

```text
messages
system prompt
streaming chunks
usage metrics
errors
rate limits
timeouts
JSON response mode
provider/model labels for stats
```

---

## 8. Database Requirements

### 8.1 Model Provider Tables

Add migrations:

```sql
CREATE TABLE model_providers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  display_name TEXT NOT NULL,
  base_url TEXT,
  api_key_ref TEXT,
  default_headers JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE model_profiles (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES model_providers(id),
  model TEXT NOT NULL,
  display_name TEXT NOT NULL,
  capabilities JSONB NOT NULL DEFAULT '{}',
  defaults JSONB NOT NULL DEFAULT '{}',
  fallback_profile_ids JSONB NOT NULL DEFAULT '[]',
  cost_hint JSONB NOT NULL DEFAULT '{}',
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Update `agent_definitions` migration:

```sql
ALTER TABLE agent_definitions
  ADD COLUMN IF NOT EXISTS model_profile_id TEXT REFERENCES model_profiles(id);
```

Seed common providers when env vars are present:

```text
anthropic
openai
openrouter
google-ai
ollama
deepseek-direct
custom-openai
```

### 8.2 Agent Tables

Add migrations for:

```sql
CREATE TABLE agent_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL,
  runtime_type TEXT NOT NULL,
  runtime_driver TEXT NOT NULL DEFAULT 'tmux',
  provider TEXT,
  model TEXT,
  model_profile_id TEXT REFERENCES model_profiles(id),
  system_prompt TEXT NOT NULL DEFAULT '',
  project_scope JSONB NOT NULL DEFAULT '[]',
  tools_policy JSONB NOT NULL DEFAULT '{}',
  permissions_policy JSONB NOT NULL DEFAULT '{}',
  memory_policy JSONB NOT NULL DEFAULT '{}',
  schedule_policy JSONB,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id UUID NOT NULL REFERENCES agent_definitions(id),
  project_id INT REFERENCES projects(id),
  session_id INT REFERENCES sessions(id),
  desired_state TEXT NOT NULL DEFAULT 'stopped',
  actual_state TEXT NOT NULL DEFAULT 'new',
  runtime_driver TEXT NOT NULL,
  runtime_handle JSONB NOT NULL DEFAULT '{}',
  heartbeat_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  stopped_at TIMESTAMPTZ,
  restart_count INT NOT NULL DEFAULT 0,
  last_snapshot TEXT,
  last_task_id UUID,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  parent_task_id UUID REFERENCES agent_tasks(id),
  project_id INT REFERENCES projects(id),
  created_by TEXT NOT NULL,
  orchestrator_agent_id UUID REFERENCES agent_instances(id),
  assigned_agent_id UUID REFERENCES agent_instances(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  priority INT NOT NULL DEFAULT 100,
  input JSONB NOT NULL DEFAULT '{}',
  result JSONB,
  error TEXT,
  lease_owner TEXT,
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_events (
  id BIGSERIAL PRIMARY KEY,
  agent_instance_id UUID REFERENCES agent_instances(id),
  task_id UUID REFERENCES agent_tasks(id),
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Update `projects`:

```sql
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS default_agent_instance_id UUID REFERENCES agent_instances(id);
```

Create uniqueness constraint:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_instances_project_name
ON agent_instances(project_id, lower((runtime_handle->>'agent_name')))
WHERE project_id IS NOT NULL;
```

Implementation note: if agent name is stored as a normal column instead of inside `runtime_handle`, prefer:

```sql
ALTER TABLE agent_instances ADD COLUMN IF NOT EXISTS name TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_instances_project_name
ON agent_instances(project_id, lower(name))
WHERE project_id IS NOT NULL AND name IS NOT NULL;
```

### 8.3 Existing Table Updates

Update `sessions`:

```sql
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS runtime_type TEXT DEFAULT 'claude-code';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS runtime_driver TEXT DEFAULT 'tmux';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_instance_id UUID REFERENCES agent_instances(id);
```

Compatibility rule:

```text
existing cli_type='claude' maps to runtime_type='claude-code'
```

### 8.4 Model Profile Seed Examples

OpenRouter provider:

```json
{
  "id": "openrouter",
  "type": "openrouter",
  "display_name": "OpenRouter",
  "base_url": "https://openrouter.ai/api/v1",
  "api_key_ref": "OPENROUTER_API_KEY",
  "default_headers": {
    "HTTP-Referer": "https://helyx.local",
    "X-Title": "Helyx"
  }
}
```

OpenRouter DeepSeek profile:

```json
{
  "id": "openrouter-deepseek-chat",
  "provider_id": "openrouter",
  "model": "deepseek/deepseek-chat",
  "display_name": "DeepSeek Chat via OpenRouter",
  "capabilities": {
    "streaming": true,
    "tools": false,
    "vision": false,
    "json_schema": false,
    "reasoning": false
  },
  "fallback_profile_ids": ["deepseek-chat-direct", "ollama-qwen3-8b"]
}
```

DeepSeek direct provider:

```json
{
  "id": "deepseek-direct",
  "type": "openai-compatible",
  "display_name": "DeepSeek Direct",
  "base_url": "https://api.deepseek.com",
  "api_key_ref": "DEEPSEEK_API_KEY"
}
```

DeepSeek direct profile:

```json
{
  "id": "deepseek-chat-direct",
  "provider_id": "deepseek-direct",
  "model": "deepseek-chat",
  "display_name": "DeepSeek Chat Direct",
  "capabilities": {
    "streaming": true,
    "tools": false,
    "vision": false,
    "json_schema": false
  }
}
```

---

## 9. Runtime Driver Requirements

### 9.1 RuntimeDriver Contract

```ts
export interface RuntimeDriver {
  readonly type: "tmux" | "pty" | "process" | "docker";

  start(instance: AgentInstance, command: RuntimeCommand): Promise<RuntimeHandle>;
  stop(handle: RuntimeHandle): Promise<void>;
  interrupt(handle: RuntimeHandle): Promise<void>;
  sendInput(handle: RuntimeHandle, input: string): Promise<void>;
  snapshot(handle: RuntimeHandle): Promise<string>;
  health(handle: RuntimeHandle): Promise<RuntimeHealth>;
}

export interface RuntimeCommand {
  cwd: string;
  env: Record<string, string>;
  argv: string[];
  label: string;
}

export interface RuntimeHealth {
  state: "running" | "stopped" | "stale" | "unknown";
  pid?: number;
  heartbeatAt?: string;
  snapshot?: string;
  error?: string;
}
```

### 9.2 tmux-driver

Initial driver must wrap existing behavior.

Responsibilities:

- Start or reuse `bots` tmux session.
- Create one window per agent/project.
- Run existing Claude command through `scripts/run-cli.sh` or a new generic launcher.
- Capture pane snapshots.
- Send Escape/Enter input.
- Kill windows reliably.

The tmux driver is compatibility-first. It should not become the new core abstraction.

### 9.3 pty-driver

Future default for interactive CLI agents.

Responsibilities:

- Start a pseudo-terminal process.
- Maintain stdout/stderr ring buffer.
- Provide `sendInput`, `interrupt`, `snapshot`, and `health`.
- Support Claude Code interactive behavior without tmux.
- Persist runtime handle with PID and log path.

### 9.4 process-driver

For non-interactive or headless tasks.

Examples:

- Codex CLI one-shot review
- Aider patch task
- Gemini CLI analysis
- local LLM summarization

### 9.5 docker-driver

For isolated or risky agents.

Responsibilities:

- Mount project directory.
- Pass minimal secrets.
- Apply CPU/memory/network constraints.
- Stream logs into `agent_events`.

---

## 10. Agent Runtime Adapter Requirements

### 10.1 AgentRuntimeAdapter Contract

```ts
export interface AgentRuntimeAdapter {
  readonly type:
    | "claude-code"
    | "codex-cli"
    | "gemini-cli"
    | "opencode"
    | "aider"
    | "standalone-llm";

  readonly capabilities: {
    interactive: boolean;
    supportsMcpChannel: boolean;
    supportsPermissions: boolean;
    supportsStreaming: boolean;
    supportsModelSwitching: boolean;
    supportsVision: boolean;
  };

  buildCommand(input: BuildCommandInput): RuntimeCommand;
  sendMessage?(instance: AgentInstance, message: AgentMessage): Promise<void>;
  parseEvent?(raw: string): AgentRuntimeEvent | null;
}
```

### 10.2 claude-code-adapter

Initial adapter must preserve current Claude Code behavior.

Command:

```bash
CHANNEL_SOURCE=remote claude --dangerously-load-development-channels server:helyx-channel
```

Requirements:

- Continue using `channel/` stdio MCP server.
- Continue supporting Telegram permission approvals.
- Continue supporting `reply`, `remember`, `recall`, `update_status`, and `send_poll`.
- Continue supporting forum topic routing.

### 10.3 codex-cli-adapter

Initial version may be one-shot and process-based.

Example use cases:

- Code review
- Diff analysis
- Test failure diagnosis

Requirements:

- Build command from task input.
- Capture stdout/stderr.
- Save result to `agent_tasks.result`.
- Do not require tmux.

### 10.4 standalone-llm-adapter

Uses internal Helyx LLM provider abstraction.

Use cases:

- summarization
- planning
- routing
- memory reconciliation
- low-cost background reasoning

Requirements:

- Must accept `modelProfileId`.
- Must use normalized `LlmClient`.
- Must support direct OpenAI-compatible APIs such as DeepSeek.
- Must support OpenRouter profiles.
- Must support fallback profiles for retryable failures.
- Must record usage in existing or extended API stats tables.
- Must not assume tool execution is available unless model profile capability `tools=true`.

---

## 11. Model Routing Requirements

### 11.1 Selection Priority

Model selection should resolve in this order:

```text
1. Task-level model_profile_id override
2. AgentDefinition.model_profile_id
3. Role default model profile
4. Global default model profile
5. Provider-specific fallback profile
```

### 11.2 Fallback Policy

Fallback is allowed for retryable failures:

```text
429 rate limit
5xx provider errors
timeout
temporary network failure
provider unavailable
```

Fallback is not allowed for non-retryable failures unless explicitly configured:

```text
invalid API key
model not found
context length exceeded
schema/tool incompatibility
policy rejection
```

Fallback must preserve task traceability:

```text
agent_events:
  model.primary_failed
  model.fallback_selected
  model.request_completed
```

### 11.3 Capability-Based Routing

Before assigning a model to a task, Helyx must check required capabilities.

Examples:

```text
Task requires vision -> model_profile.capabilities.vision=true
Task requires JSON schema -> model_profile.capabilities.jsonSchema=true
Task requires tool calls -> model_profile.capabilities.tools=true
Task requires cheap summarization -> allow ollama/local profile
```

If no model supports required capabilities, task should fail with a clear configuration error.

### 11.4 Recommended Initial Model Defaults

Recommended practical setup:

```text
coder
  runtime_type: claude-code
  runtime_driver: tmux or pty
  model_profile_id: claude-code-sonnet

orchestrator
  runtime_type: standalone-llm
  runtime_driver: process
  model_profile_id: deepseek-chat-direct or openrouter-deepseek-chat

planner
  runtime_type: standalone-llm
  runtime_driver: process
  model_profile_id: deepseek-chat-direct

reviewer
  runtime_type: codex-cli or standalone-llm
  runtime_driver: process
  model_profile_id: openrouter-claude-sonnet or codex-default

summarizer
  runtime_type: standalone-llm
  runtime_driver: process
  model_profile_id: ollama-qwen3-8b
```

### 11.5 Important DeepSeek Limitation

DeepSeek or other OpenAI-compatible API models can act as:

```text
planner
orchestrator
researcher
summarizer
text reviewer
triage agent
```

They must not be treated as full code-writing agents until a tool-execution layer is implemented for them.

For code-writing tasks, use one of:

```text
claude-code
opencode
codex-cli
aider
gemini-cli
```

or implement a secure tool adapter with approvals and sandboxing.

---

## 12. AgentManager Requirements

Create `agents/agent-manager.ts`.

Responsibilities:

- CRUD for `agent_definitions`.
- Create and update `agent_instances`.
- Set desired state.
- Resolve project-scoped agents.
- Create default agents for each project.
- Expose service methods used by Telegram and dashboard.

Required API:

```ts
class AgentManager {
  listDefinitions(): Promise<AgentDefinition[]>;
  createDefinition(input: CreateAgentDefinitionInput): Promise<AgentDefinition>;
  updateDefinition(id: string, patch: Partial<AgentDefinition>): Promise<AgentDefinition>;

  listInstances(projectId?: number): Promise<AgentInstance[]>;
  ensureInstance(definitionId: string, projectId?: number): Promise<AgentInstance>;
  setDesiredState(instanceId: string, state: "running" | "stopped" | "paused"): Promise<void>;
}
```

---

## 13. RuntimeManager Requirements

Create `runtime/runtime-manager.ts`.

Responsibilities:

- Poll or listen for agent instances that need reconciliation.
- Compare desired state and actual health.
- Start, stop, restart, or mark failed.
- Write `agent_events`.
- Maintain heartbeat.
- Never depend on Telegram request lifecycle.

Reconcile logic:

```text
if desired=running and actual in [new, stopped, failed]:
  start instance

if desired=running and health=stale:
  restart instance or escalate after retry limit

if desired=stopped and actual in [running, busy, waiting_approval]:
  stop instance

if desired=paused:
  do not assign new tasks; keep instance alive if already running
```

Required safety:

- Use DB leases to prevent multiple RuntimeManager processes from starting the same agent.
- Never start duplicate interactive agents for the same project unless explicitly allowed.
- Restart loops must have backoff and max retry count.

---

## 14. TaskManager and Orchestration Requirements

Create `agents/task-manager.ts`.

Responsibilities:

- Create tasks from Telegram/dashboard/API.
- Assign tasks to agents by role and capability.
- Lease tasks to running agents.
- Track status and result.
- Support parent-child task DAG.

Initial orchestration flow:

```text
User asks: "Implement feature X"
  -> create parent task type=implement
  -> orchestrator creates child tasks:
      1. analyze
      2. plan
      3. implement
      4. test
      5. review
  -> assign tasks to specialized agents
  -> aggregate result
  -> report to Telegram topic
```

Minimum viable orchestration:

- One orchestrator agent.
- One implementer agent.
- One reviewer agent.
- Manual task creation from Telegram command.
- Result posted back to project topic.

---

## 15. Telegram UX Requirements

Existing `/projects` should remain working.

### 14.1 General Topic Responsibilities

The General forum topic is the global control plane. It should not route ordinary chat messages to a project agent.

Allowed General topic actions:

```text
/projects
/agents
/tasks
/incidents
/runtime_status
/start_all
/stop_all
/agent_start <project> <agent>
/agent_stop <project> <agent>
/agent_restart <project> <agent>
/agent_status <project>
```

General topic output should show all projects and agents:

```text
Helyx
🟢 coder        claude-code / tmux       running
⚪ planner      deepseek-chat / process   stopped
🟡 reviewer     codex-cli / process       paused

Heryx
🟢 orchestrator deepseek-chat / process   running
🔴 coder        claude-code / pty         failed
```

Each row should expose inline actions:

```text
[Start] [Stop] [Restart] [Pause] [Logs] [Snapshot] [Tasks]
```

These actions must update desired state only. They must not execute tmux, PTY, Docker, or shell operations directly from Telegram handlers.

### 14.2 Project Topic Responsibilities

Project topics are workspace channels. A single project topic may contain multiple project agents.

Allowed project-topic actions:

```text
/agent_status
/agents
/start_agent <agent>
/stop_agent <agent>
/restart_agent <agent>
/task <instruction>
/task @agent_name <instruction>
/ask <agent_name> <question>
/orchestrate <instruction>
```

Ordinary message routing:

```text
User message in project topic:
  "fix the failing tests"

Router:
  topic -> project -> default_agent -> enqueue message/task
```

Explicit agent routing:

```text
@planner propose runtime-driver architecture
@reviewer review the latest diff
@coder implement tmux-driver extraction
```

Command routing:

```text
/task @reviewer review current branch
/orchestrate add provider-agnostic runtime layer
```

Agent replies should include a short role prefix to avoid ambiguity in shared project rooms:

```text
[coder] Implemented runtime-driver extraction.
[planner] Recommended migration sequence: ...
[reviewer] Found 2 risks in the current diff.
```

Add new commands:

```text
/agents
  List agent instances by project, desired state, actual state, runtime, model.

/agent_start <agent_or_project>
  Set desired_state=running.

/agent_stop <agent_or_project>
  Set desired_state=stopped.

/agent_restart <agent_or_project>
  Stop then start via RuntimeManager.

/tasks
  List active and recent agent tasks.

/task <instruction>
  Create a task for the current project topic.

/orchestrate <instruction>
  Create a parent task assigned to orchestrator.
```

Model/provider commands:

```text
/providers
  List configured model providers and validation status.

/models
  List configured model profiles, capabilities, and defaults.

/agent_model <project> <agent> <model_profile_id>
  Set model profile for a project agent.

/task_model <task_id> <model_profile_id>
  Override model profile for a specific task.
```

Existing project buttons should eventually call:

```text
AgentManager.setDesiredState(instanceId, "running")
```

Instead of inserting tmux-specific `proj_start`.

### 14.3 Multi-Agent Topic Constraints

Multiple agents may be assigned to one project topic, but concurrency must be controlled.

Rules:

1. A project should have exactly one default agent.
2. A project should normally have at most one active long-running coder agent per working tree.
3. Planner, reviewer, tester, and summarizer agents may be one-shot/process agents.
4. If multiple code-writing agents are needed, they must use separate worktrees or sandboxed copies.
5. Each task must have one owner agent at a time.
6. Orchestrator may create child tasks, but each child task must be assigned to a specific agent.
7. If a user message does not specify an agent, it must route to the default agent.
8. If the default agent is stopped, the router should either:
   - ask user to start it,
   - route to orchestrator if available,
   - or create a queued task waiting for the default agent.

---

## 16. Dashboard Requirements

Add dashboard pages or tabs:

### Agents Page

Show:

- name
- role
- project
- runtime type
- runtime driver
- provider/model
- desired state
- actual state
- heartbeat age
- restart count
- last task

Actions:

- Start
- Stop
- Restart
- Pause
- View logs
- View terminal snapshot

### Tasks Page

Show:

- task id
- project
- type
- status
- assigned agent
- created time
- duration
- result preview

Actions:

- Cancel
- Retry
- Reassign
- Open details

### Models Page

Show:

- provider id
- provider type
- display name
- base URL
- API key configured: yes/no, never show value
- enabled
- validation status

Show model profiles:

- profile id
- provider
- model id
- display name
- capabilities
- fallbacks
- default temperature/max tokens
- enabled

Actions:

- Validate provider
- Enable/disable provider
- Set role default
- Assign model profile to agent
- Test prompt

Security:

- Never display API key values.
- Only show `api_key_ref`.

---

## 17. Installation And Setup Wizard Requirements

Helyx already has an installation and setup wizard through the CLI, centered around:

```text
install.sh
cli.ts
helyx setup
.env.example
docker-compose.yml
scripts/run-cli.sh
scripts/admin-daemon.ts
```

The refactor must extend this existing setup flow instead of replacing it.

### 16.1 Installer Compatibility

Existing install commands must remain valid:

```bash
curl -fsSL https://raw.githubusercontent.com/MrCipherSmith/helyx/main/install.sh | bash
helyx setup
```

Existing users must be able to upgrade without recreating their Telegram bot, database, projects, topics, or memories.

Installer requirements:

1. Detect existing `.env`.
2. Detect existing database schema version.
3. Run additive migrations.
4. Create default agent definitions for existing projects.
5. Assign each existing project a default Claude Code agent.
6. Preserve existing forum topic mappings.
7. Preserve existing `sessions`, `messages`, `memories`, `permission_requests`, and dashboard data.
8. Never overwrite secrets without explicit confirmation.

### 16.2 Setup Wizard: New Questions

Add a new setup section:

```text
Agent Runtime Configuration
```

Required prompts:

```text
Default runtime driver for interactive coding agents:
  1. tmux (recommended for existing installs)
  2. pty (experimental, no tmux)
  3. docker (sandboxed, advanced)

Default coding runtime:
  1. Claude Code (recommended if already installed)
  2. OpenCode
  3. Codex CLI
  4. Gemini CLI
  5. None, configure later

Create default project agents?
  1. Yes, create coder agent for every project
  2. No, I will configure agents manually

Create planning/review agents?
  1. Yes, create planner + reviewer using API models
  2. No, coder only
```

If user selects API-based agents:

```text
API model provider:
  1. OpenAI-compatible custom endpoint
  2. OpenRouter
  3. Anthropic
  4. Google AI
  5. Ollama
```

For OpenAI-compatible custom endpoint:

```text
Base URL [https://api.deepseek.com]:
API key:
Planner model [deepseek-chat]:
Reviewer model [deepseek-chat]:
Orchestrator model [deepseek-chat]:
```

The wizard must create or update `model_providers` and `model_profiles`, not only write `.env`.

For OpenRouter:

```text
OpenRouter API key:
Default planner model [deepseek/deepseek-chat]:
Default reviewer model [anthropic/claude-sonnet-4.5]:
```

For a custom OpenAI-compatible provider:

```text
Provider display name [DeepSeek]:
Provider ID [deepseek-direct]:
Base URL [https://api.deepseek.com]:
API key env name [DEEPSEEK_API_KEY]:
API key:
Default model [deepseek-chat]:
```

### 16.3 Setup Wizard: Environment Variables

Add or normalize these env vars:

```env
# Agent runtime
DEFAULT_RUNTIME_DRIVER=tmux
DEFAULT_CODING_RUNTIME=claude-code
AGENT_RECONCILE_INTERVAL_MS=5000
AGENT_HEARTBEAT_TIMEOUT_MS=120000
AGENT_RESTART_LIMIT=3

# OpenAI-compatible custom provider, e.g. DeepSeek
CUSTOM_OPENAI_API_KEY=
CUSTOM_OPENAI_BASE_URL=https://api.deepseek.com
CUSTOM_OPENAI_DEFAULT_MODEL=deepseek-chat

# DeepSeek direct convenience aliases
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com

# Optional role defaults
DEFAULT_ORCHESTRATOR_PROVIDER=custom-openai
DEFAULT_ORCHESTRATOR_MODEL=deepseek-chat
DEFAULT_PLANNER_PROVIDER=custom-openai
DEFAULT_PLANNER_MODEL=deepseek-chat
DEFAULT_REVIEWER_PROVIDER=openrouter
DEFAULT_REVIEWER_MODEL=
```

Compatibility:

```text
OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
OPENROUTER_API_KEY / OPENROUTER_BASE_URL / OPENROUTER_MODEL
GOOGLE_AI_API_KEY / GOOGLE_AI_MODEL
ANTHROPIC_API_KEY / CLAUDE_MODEL
OLLAMA_URL / OLLAMA_CHAT_MODEL
```

must continue to work.

### 16.4 Setup Wizard: Agent Bootstrap

After DB migration, setup should optionally create:

```text
Global agent definitions:
  - claude-coder
  - deepseek-planner
  - codex-reviewer
  - shell-tester
  - orchestrator

Per-project agent instances:
  - <project>:coder
  - <project>:planner
  - <project>:reviewer
```

Default conservative bootstrap:

```text
For every existing project:
  default_agent = coder
  coder.runtime_type = claude-code
  coder.runtime_driver = tmux
  coder.desired_state = stopped
```

If the project already has an active remote Claude session:

```text
Link that session to the new coder agent instance.
Set actual_state based on current session state.
Do not restart it automatically.
```

### 16.5 Setup Wizard: DeepSeek Quick Setup

The wizard should support a direct DeepSeek path:

```text
Use DeepSeek for planner/orchestrator agents?
  1. Yes
  2. No

DeepSeek API key:
DeepSeek base URL [https://api.deepseek.com]:
Model [deepseek-chat]:
```

Resulting config:

```text
planner.runtime_type = standalone-llm
planner.provider = custom-openai
planner.model = deepseek-chat
planner.runtime_driver = process

orchestrator.runtime_type = standalone-llm
orchestrator.provider = custom-openai
orchestrator.model = deepseek-chat
orchestrator.runtime_driver = process
```

Resulting DB seed:

```text
model_providers:
  id = deepseek-direct
  type = openai-compatible
  base_url = https://api.deepseek.com
  api_key_ref = DEEPSEEK_API_KEY

model_profiles:
  id = deepseek-chat-direct
  provider_id = deepseek-direct
  model = deepseek-chat
```

Important limitation to show in wizard:

```text
DeepSeek planner/orchestrator agents can reason, plan, review text, and route tasks.
They do not edit files or run terminal commands until tool execution is configured.
Use Claude Code/OpenCode/Codex/Aider for code-writing agents.
```

### 16.6 Setup Wizard: Validation

The wizard must validate:

1. Bun installed.
2. Docker available if Docker deployment selected.
3. PostgreSQL reachable.
4. Telegram token valid.
5. Forum setup status if existing install.
6. Claude Code installed if default coding runtime is `claude-code`.
7. tmux installed if default runtime driver is `tmux`.
8. PTY dependency installed if default runtime driver is `pty`.
9. API key and base URL work for API-based providers.
10. Ollama reachable if selected.

Validation should be non-destructive and should not start or stop existing agents without confirmation.

### 16.7 CLI Management Commands

Extend `helyx` CLI:

```text
helyx agents                  List agent definitions and instances
helyx agent create            Create an agent definition or instance
helyx agent start <name>      Set desired_state=running
helyx agent stop <name>       Set desired_state=stopped
helyx agent restart <name>    Restart via RuntimeManager
helyx agent logs <name>       Show runtime logs/events
helyx agent snapshot <name>   Show latest runtime snapshot
helyx runtime status          Show RuntimeManager and driver health
helyx runtime doctor          Validate tmux/pty/process/docker prerequisites
helyx setup-agents            Re-run only agent setup wizard
helyx providers               List model providers
helyx provider test <id>      Validate provider credentials and endpoint
helyx models                  List model profiles
helyx model set <agent> <profile>  Assign model profile to agent
```

Backward compatibility:

```text
helyx up
helyx down
helyx ps
helyx add
helyx run
helyx connect
```

should continue to work, but may internally call new agent/runtime APIs.

---

## 18. Migration Plan

### Phase 1: Naming and Compatibility Refactor

Goal: no behavior change.

Tasks:

1. Rename conceptual types:
   - `cli_type` -> `runtime_type` in TypeScript types first.
   - Preserve DB `cli_type` for compatibility until migration is ready.
2. Change adapter registry to accept multiple runtime types.
3. Replace `readonly type: "claude"` with generic string union.
4. Rename `claude/client.ts` to `llm/client.ts` or add a compatibility re-export.
   - **Import chain caution**: `claude/client.ts` is imported from `channel/`, `mcp/`, `utils/`, and `bot/`. Also note that `channel.ts` exists both as a root-level file and as `channel/` directory. Prefer adding a re-export at `claude/client.ts` first, then migrate imports incrementally.
5. Update `/model` to read model options from runtime/provider config.
   - Current: `CLAUDE_MODELS` const array in `bot/commands/model.ts`. Replace with dynamic list sourced from runtime config or a provider registry stub (even if it only returns Claude models in Phase 1).

Affected files:

```text
adapters/types.ts
adapters/index.ts
sessions/manager.ts     (rename cliType references in TS only, DB column unchanged)
claude/client.ts        (add re-export at old path, create llm/client.ts)
bot/commands/model.ts   (replace hardcoded CLAUDE_MODELS array)
```

Acceptance Criteria:

- Existing Claude/tmux flow still works.
- Unit tests pass.
- No user-visible behavior changes except neutral naming in new code.

### Phase 2: Runtime Driver Extraction

Goal: isolate tmux logic.

Tasks:

1. Create `runtime/types.ts` — `RuntimeDriver` interface, `RuntimeHandle`, `RuntimeCommand`, `RuntimeHealth`.
2. Create `runtime/drivers/tmux-driver.ts` — implement `RuntimeDriver` wrapping existing tmux shell logic.
3. Move `proj_start`, `proj_stop`, and `tmux_send_keys` logic from `scripts/admin-daemon.ts` into `tmux-driver.ts`.
4. Update `scripts/tmux-watchdog.ts` to use `tmux-driver.health()` instead of direct shell calls.
5. Create `runtime/runtime-manager.ts` facade — delegates to registered driver.
6. Keep `proj_start/proj_stop` commands in `admin-daemon.ts` but implement them via `RuntimeManager`.
7. Update `bot/commands/tmux-actions.ts` to call `RuntimeManager` instead of direct shell commands.
8. Update `bot/commands/supervisor-actions.ts` similarly if it contains direct process/tmux calls.
9. **`projects.tmux_session_name` column**: keep as-is in Phase 2 — move to `runtime_handle` JSONB only in Phase 4 when `agent_instances` table is introduced. Do NOT rename or remove in this phase.

Affected files:

```text
runtime/types.ts                         (new)
runtime/drivers/tmux-driver.ts           (new)
runtime/runtime-manager.ts               (new)
scripts/admin-daemon.ts                  (remove raw tmux logic)
scripts/tmux-watchdog.ts                 (use driver.health())
services/project-service.ts             (call RuntimeManager instead of admin-daemon action)
bot/commands/tmux-actions.ts            (call RuntimeManager)
bot/commands/supervisor-actions.ts      (call RuntimeManager if applicable)
tests/unit/runtime-driver.test.ts        (new)
```

Acceptance Criteria:

- `/projects` start/stop works as before.
- tmux-specific shell commands are no longer embedded in `admin-daemon.ts` or `tmux-watchdog.ts`.
- Runtime events are logged to stdout (full `agent_events` table comes in Phase 4).
- `projects.tmux_session_name` column still exists and is used by the tmux driver.

### Phase 3: Model Provider Layer

Goal: support per-agent and per-task model routing through OpenRouter and OpenAI-compatible APIs.

**Codebase reality**: `claude/client.ts` (→ `llm/client.ts` after Phase 1) already supports Anthropic, Google AI, OpenRouter, and Ollama via env-based provider detection. Phase 3 is therefore about adding a `model_profiles` routing layer on top — NOT rewriting the client from scratch. The existing retry logic, `contentToString` normalization, and `recordApiRequest` stats integration should be preserved.

Tasks:

1. Add `model_providers` and `model_profiles` DB tables (see §8.1).
2. Add `agent_definitions.model_profile_id` column.
3. Refactor `llm/client.ts` to accept `modelProfileId` as input and resolve the provider/model/baseUrl/apiKey from `model_profiles` + `model_providers` tables — replacing the current env-var detection at call time.
   - The existing provider-specific branches (anthropic SDK, openai-compatible, ollama) become sub-clients under the normalized `LlmClient`.
   - Keep `recordApiRequest` integration for stats.
4. Seed `model_providers` and `model_profiles` from existing env vars on first run.
5. Ensure OpenRouter provider uses required extra headers (`HTTP-Referer`, `X-Title`).
6. Add model fallback policy (see §11.2).
7. Add `/providers`, `/models`, `/agent_model` Telegram commands.
8. Extend setup wizard to create provider/profile records.

Affected files:

```text
llm/client.ts                (refactor from claude/client.ts)
llm/types.ts                 (new: LlmClient, LlmGenerateInput, LlmResult interfaces)
llm/providers/               (new: per-provider sub-clients)
memory/db.ts                 (new migrations: model_providers, model_profiles)
config.ts                    (add CUSTOM_OPENAI_*, DEEPSEEK_* env vars)
bot/commands/model.ts        (add /providers, /models)
```

Acceptance Criteria:

- A planner agent can use DeepSeek direct API via `model_profile_id`.
- A reviewer agent can use OpenRouter model profile.
- A task can override agent default model profile.
- Provider failures are recorded (in logs in Phase 3; in `agent_events` table in Phase 4).
- Retryable failures can use configured fallback profiles.
- API keys are referenced by env var and never stored directly in DB.
- Existing Anthropic/Ollama/OpenRouter functionality is not broken.

### Phase 4: Agent Tables, Desired State, And Setup Wizard Upgrade

Goal: introduce persistent agents.

**State machine reconciliation note**: `sessions/state-machine.ts` manages the existing session lifecycle (inactive → connecting → active → disconnected, etc.). Phase 4 introduces `AgentInstance.actualState` as a separate, broader runtime lifecycle. Strategy:
- Keep `sessions/state-machine.ts` as the **communication session** state machine (Claude channel connected/disconnected).
- `AgentInstance.actualState` tracks the **runtime process** state (new/starting/running/stopped/failed).
- A running agent instance may have zero or one associated active session.
- Do NOT merge these two machines — they model different concerns at different layers.

Tasks:

1. Add `agent_definitions`, `agent_instances`, `agent_tasks`, `agent_events` DB tables (see §8.2).
2. Create default agent definition for Claude Code project agent.
3. Link existing projects to one default agent instance.
4. Add `projects.default_agent_instance_id`.
5. Migrate `projects.tmux_session_name` → store in `agent_instances.runtime_handle` JSONB. Keep the column with a deprecation comment for now; remove in Phase 5+.
6. Telegram project start/stop updates `agent_instances.desired_state` (not direct tmux call).
7. RuntimeManager reconciles desired state using the registered driver.
8. Update `sessions/router.ts` to route project-topic messages to `projects.default_agent_instance_id` instead of directly to sessions.
9. Add `@agent_name` routing in `sessions/router.ts` for explicit agent addressing.
10. Extend `helyx setup` with agent runtime configuration.
11. Add `helyx setup-agents` for existing installs.
12. Add DeepSeek/OpenAI-compatible planner/orchestrator quick setup.

Affected files:

```text
memory/db.ts                     (new migrations: agent_definitions, agent_instances, agent_tasks, agent_events)
sessions/router.ts               (route to agent instances + @agent_name routing)
sessions/manager.ts              (link session to agent_instance_id)
services/project-service.ts     (start/stop via desired_state, not proj_start command)
agents/agent-manager.ts         (new)
runtime/runtime-manager.ts      (extend: reconcile loop, desired state)
```

Acceptance Criteria:

- Starting a project via Telegram updates `agent_instances.desired_state`.
- RuntimeManager starts tmux session via the tmux driver.
- DB actual state reflects runtime state.
- Duplicate starts are idempotent (DB lease guards).
- General topic shows all projects and agents.
- Project topic routes ordinary messages to default agent.
- Project topic routes `@agent_name` messages to named agent.
- `sessions/state-machine.ts` transitions still work for the communication channel layer.
- Existing installs can run setup upgrade without losing projects, topics, sessions, or memories.
- Wizard can create DeepSeek-backed planner/orchestrator agents.

### Phase 5: PTY Driver Prototype

Goal: run one Claude Code session without tmux.

Tasks:

1. Add PTY dependency or native PTY wrapper.
2. Implement `pty-driver`.
3. Add `RUNTIME_DRIVER=tmux|pty`.
4. Support snapshot, interrupt, stop, health.
5. Test on one project only.

Acceptance Criteria:

- Claude Code can run via PTY.
- Telegram can send messages and receive replies.
- Permissions still work through MCP channel.
- Dashboard can show snapshot/log output.
- tmux remains default.

### Phase 6: Codex CLI Adapter

Goal: add first non-Claude runtime.

Tasks:

1. Implement `codex-cli-adapter`.
2. Use process driver for one-shot review tasks.
3. Add `/codex_review` to create an `agent_task`.
4. Save result to task result and post to Telegram.

Acceptance Criteria:

- User can trigger Codex review from Telegram.
- Output is persisted in `agent_tasks`.
- Failure states are visible.
- No tmux required.

### Phase 7: Orchestrator MVP

Goal: persistent specialized agents and task delegation.

Tasks:

1. Create default orchestrator agent.
2. Add `/orchestrate`.
3. Orchestrator decomposes parent task into child tasks.
4. Assign child tasks to available role agents.
5. Aggregate final report.

Acceptance Criteria:

- A user can create a multi-step task from Telegram.
- The orchestrator creates visible child tasks.
- Each task has status and assigned agent.
- Final result is reported to the correct forum topic.

---

## 19. Backward Compatibility Requirements

The following must not break:

- Existing project registration.
- Existing forum topic routing.
- Existing General topic control-only behavior.
- Existing Claude Code sessions.
- Existing message queue behavior.
- Existing memory and summarization.
- Existing permission approval flow.
- Existing dashboard session view.
- Existing `/projects`, `/sessions`, `/switch`, `/standalone`.
- Existing env-based standalone provider selection should keep working as fallback.

Compatibility mappings:

```text
sessions.cli_type='claude' -> runtime_type='claude-code'
project remote session -> default agent instance
proj_start/proj_stop -> agent_start/agent_stop compatibility wrapper
tmux window -> runtime_handle.driver='tmux'
project forum topic -> project room, not single-agent identity
OPENROUTER_* env vars -> seeded openrouter model provider/profile
OPENAI_BASE_URL + OPENAI_API_KEY -> seeded openai-compatible provider/profile
```

---

## 20. Security Requirements

1. Runtime drivers must validate paths before executing commands.
2. Runtime drivers must avoid shell interpolation where possible.
3. Secrets must be scoped per runtime and not blindly inherited.
4. Docker driver must support restricted mounts and network policies.
5. PTY/process drivers must write logs to controlled paths.
6. Agent permissions must be explicit and role-based.
7. Dangerous commands must continue to require Telegram approval unless allowlisted.
8. Agent tasks must record who created them.
9. Runtime restart loops must avoid infinite crash loops.
10. Setup wizard must never print API keys back to the terminal or Telegram.
11. Setup wizard must not overwrite existing `.env` values without confirmation.
12. Model provider API keys must never be stored directly in DB.
13. Provider test commands must redact Authorization headers and secrets from logs.

---

## 21. Observability Requirements

Every lifecycle action must emit `agent_events`.

Event examples:

```text
agent.created
agent.desired_state_changed
runtime.start_requested
runtime.started
runtime.heartbeat
runtime.snapshot_updated
runtime.interrupted
runtime.stopped
runtime.failed
task.created
task.assigned
task.started
task.completed
task.failed
approval.requested
approval.approved
approval.rejected
model.request_started
model.request_completed
model.primary_failed
model.fallback_selected
```

Dashboard and Telegram should expose:

- current desired state
- current actual state
- last heartbeat age
- last error
- restart count
- active task
- latest snapshot
- active model profile
- provider fallback history

---

## 22. Testing Requirements

### Unit Tests

Add pure unit tests for:

- runtime state transitions
- desired vs actual reconcile decisions
- adapter registry
- model/provider resolution
- task status transitions
- path validation
- setup wizard config generation
- existing install upgrade bootstrap
- model profile resolution priority
- provider fallback policy
- OpenRouter request normalization
- OpenAI-compatible request normalization

### Integration Tests

Add integration tests for:

- `tmux-driver.start/stop` behind feature flag or mocked shell runner
- RuntimeManager idempotent start
- stale heartbeat recovery
- task assignment
- setup wizard provider validation using mocked HTTP responses
- DeepSeek/OpenAI-compatible provider using mocked chat completions endpoint
- OpenRouter provider headers and model ID mapping

### E2E Tests

Add E2E tests later for:

- Telegram project start -> agent running
- Telegram task -> task completed
- dashboard agent page renders states
- existing install upgrade preserves project topics
- `/agent_model` changes planner model profile and next task uses it

---

## 23. Acceptance Criteria

### MVP Acceptance Criteria

1. Existing Claude/tmux sessions still work.
2. Runtime logic is accessible through a generic `RuntimeManager`.
3. tmux start/stop logic is isolated in `tmux-driver`.
4. Helyx has persistent `agent_definitions` and `agent_instances`.
5. Telegram start/stop can operate through desired state.
6. Supervisor/reconciler starts stopped agents when desired state is running.
7. At least one non-Claude runtime adapter can run as a one-shot task.
8. Agent state and task state are visible in DB and at least one UI surface.
9. General topic can manage agent state globally.
10. Project topic can route ordinary messages to the default agent.
11. Project topic can route explicit `@agent_name` messages to a non-default agent.
12. Setup wizard can configure default runtime driver and default coding runtime.
13. Setup wizard can configure DeepSeek or another OpenAI-compatible model for planner/orchestrator agents.
14. Model providers and model profiles exist as first-class DB records.
15. Agents can use different models through OpenRouter or direct OpenAI-compatible APIs.
16. Per-task model override works.

### Full Refactor Acceptance Criteria

1. Claude Code can run through either tmux or PTY driver.
2. Codex CLI can run without tmux.
3. Specialized agents can be configured and kept alive.
4. Orchestrator can delegate tasks to specialized agents.
5. Runtime health is driver-agnostic.
6. tmux is optional, not required by architecture.
7. Model routing is agent/task-specific and provider-agnostic.
8. Fallback model routing is observable and configurable.

---

## 24. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| PTY behavior differs from tmux | Claude interactive UX may break | Keep tmux default; prototype PTY on one project |
| Schema migration complexity | Existing installs may break | Add compatibility columns first; avoid destructive migrations |
| Duplicate agent starts | Conflicting sessions or data races | DB leases and unique constraints |
| Runtime abstraction too generic | Slow implementation | Start with tmux-driver only; add drivers incrementally |
| Permissions differ by runtime | Security regression | Capabilities matrix per adapter |
| Dashboard scope grows too fast | Delayed MVP | Add minimal Agents view first |
| Setup wizard grows too complex | Bad onboarding | Split into core setup and `helyx setup-agents` |
| Existing users fear migration | Adoption risk | Use non-destructive additive migrations and clear dry-run summary |
| Provider APIs differ despite OpenAI compatibility | Runtime errors | Use provider-specific client adapters under normalized LLM client |
| Wrong model selected for tool task | Broken task execution | Capability-based routing and validation |

---

## 25. Open Questions

1. Should `agent_instances` replace `sessions`, or should sessions remain the communication layer?
   - Recommendation: keep sessions as communication context; add agent_instances as runtime/lifecycle layer.
2. Should each project get default agents automatically?
   - Recommendation: yes, create one default `project-agent` matching current behavior.
3. Should tmux remain visible to users?
   - Recommendation: yes as debug backend, but not as the primary UX concept.
4. Should PTY driver be implemented in Bun directly or via Node-compatible package?
   - Recommendation: evaluate `node-pty` compatibility; otherwise isolate in a small Node helper process.
5. Should Codex/OpenCode/Aider be long-running or one-shot first?
   - Recommendation: one-shot first.
6. Should DeepSeek setup use `OPENAI_*`, `OPENROUTER_*`, or new `CUSTOM_OPENAI_*` variables?
   - Recommendation: support all, but use `CUSTOM_OPENAI_*` in wizard to avoid conflicting with OpenAI/OpenRouter settings.
7. Should agent setup run during first install by default?
   - Recommendation: yes, but keep advanced agent creation optional.
8. Should model providers be editable through Telegram?
   - Recommendation: allow viewing and validation in Telegram, but prefer dashboard/CLI for creating providers because secrets are involved.
9. Should OpenRouter be modeled as `openai-compatible` only?
   - Recommendation: no, use a dedicated `openrouter` type because it needs headers, model naming conventions, and provider-specific metadata.

---

## 26. Suggested File Layout

```text
agents/
  agent-manager.ts
  task-manager.ts
  orchestrator.ts
  types.ts

runtime/
  runtime-manager.ts
  types.ts
  drivers/
    tmux-driver.ts
    pty-driver.ts
    process-driver.ts
    docker-driver.ts

adapters/
  runtime-types.ts
  registry.ts
  claude-code.ts
  codex-cli.ts
  gemini-cli.ts
  opencode.ts
  aider.ts
  standalone-llm.ts

llm/
  client.ts
  types.ts
  model-registry.ts
  model-router.ts
  providers/
    anthropic.ts
    openai-compatible.ts
    openrouter.ts
    ollama.ts
    google-ai.ts

setup/
  agent-wizard.ts
  provider-validation.ts
  default-agent-bootstrap.ts
```

---

## 27. Implementation Notes For AI Agents

When implementing this PRD:

1. Preserve behavior before adding features.
2. Prefer additive migrations.
3. Do not delete tmux code in early phases.
4. Extract interfaces first, then move logic.
5. Keep Claude Code working as the golden path.
6. Add tests for state machines before changing runtime behavior.
7. Do not restart production containers without explicit user confirmation.
8. Keep user-facing Telegram commands backward compatible.
9. Extend the existing setup wizard; do not create a second competing installer.
10. Provide `helyx setup-agents` so existing users can adopt agent runtime features without rerunning full setup.
11. Do not pass raw model strings through agent code when `model_profile_id` is available.
12. Treat OpenRouter as its own provider type even though it is OpenAI-compatible.
13. Treat DeepSeek direct as `openai-compatible`.

---

## 28. Minimal First Patch Scope

Recommended first implementation task:

```text
Extract tmux runtime driver without changing user behavior.
```

Files to create:

```text
runtime/types.ts                    (RuntimeDriver interface, RuntimeHandle, RuntimeCommand, RuntimeHealth)
runtime/drivers/tmux-driver.ts      (TmuxDriver implements RuntimeDriver)
runtime/runtime-manager.ts          (RuntimeManager facade, driver registry)
tests/unit/runtime-driver.test.ts   (unit tests for state transitions)
```

Files to update:

```text
scripts/admin-daemon.ts             (proj_start/proj_stop/tmux_send_keys → delegate to tmux driver)
scripts/tmux-watchdog.ts            (replace direct tmux shell calls with driver.health())
services/project-service.ts         (start/stop via RuntimeManager, keep tmux_session_name as-is)
bot/commands/tmux-actions.ts        (route Telegram tmux actions through RuntimeManager)
```

Expected result:

```text
Telegram /projects still works.
admin-daemon no longer contains raw project tmux start/stop implementation.
tmux-watchdog no longer calls tmux shell directly.
tmux behavior is hidden behind RuntimeDriver.
projects.tmux_session_name column unchanged (migrated in Phase 4).
```

## 29. Codebase Verification (2026-04-24)

Verified against actual codebase before writing Phase 2–4 task lists. The following PRD assumptions were confirmed or corrected:

| PRD Assumption | Reality | Impact |
|---|---|---|
| `adapters/types.ts → readonly type: "claude"` | ✅ confirmed | Phase 1 scope correct |
| `sessions/manager.ts → cliType: "claude"` | ✅ confirmed, 6+ locations | Phase 1 scope correct |
| `admin-daemon.ts → raw tmux shell` | ✅ confirmed (`proj_start`, `proj_stop`, `tmux_send_keys`) | Phase 2 scope correct |
| `claude/client.ts` is Claude-only | ❌ wrong — already supports Anthropic, Google AI, OpenRouter, Ollama | Phase 3 effort significantly reduced |
| `runtime/` directory exists | ❌ does not exist | Phase 2 must create from scratch |
| `agents/` directory exists | ❌ does not exist | Phase 4 must create from scratch |
| `services/project-service.ts` file exists | ✅ exists, has `tmux_session_name` field | Phase 2 must handle this column |
| `sessions/` has state machine | ❌ not mentioned — `sessions/state-machine.ts` exists | Phase 4 must define reconciliation strategy |
| `sessions/router.ts` mentioned in Phase 4 | ❌ not mentioned — exists and is the routing entry point | Phase 4 must update this file |
| `scripts/tmux-watchdog.ts` mentioned | ❌ not mentioned — has direct tmux shell calls | Phase 2 must update alongside admin-daemon |
| `bot/commands/tmux-actions.ts` mentioned | ❌ not mentioned — direct tmux ops from Telegram | Phase 2 must update |

