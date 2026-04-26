const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (res.status === 401) {
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  // Auth
  authMe: () => request<AuthUser>('/auth/me'),
  authTelegram: (data: TelegramLoginData) =>
    request<AuthUser>('/auth/telegram', { method: 'POST', body: JSON.stringify(data) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),

  // Overview
  overview: () => request<Overview>('/overview'),

  // Sessions
  sessions: () => request<Session[]>('/sessions'),
  session: (id: number) => request<SessionDetail>(`/sessions/${id}`),
  sessionMessages: (id: number, limit = 50, offset = 0) =>
    request<PaginatedMessages>(`/sessions/${id}/messages?limit=${limit}&offset=${offset}`),
  deleteSession: (id: number) => request<void>(`/sessions/${id}`, { method: 'DELETE' }),
  renameSession: (id: number, name: string) =>
    request<Session>(`/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),

  // Stats
  stats: () => request<Stats>('/stats'),
  dailyStats: (days = 30) => request<DailyStats[]>(`/stats/daily?days=${days}`),
  recentErrors: (limit = 20) => request<ApiError[]>(`/stats/errors?limit=${limit}`),

  // Logs
  logs: (params?: LogsParams) => {
    const q = new URLSearchParams();
    if (params?.session_id) q.set('session_id', String(params.session_id));
    if (params?.level) q.set('level', params.level);
    if (params?.search) q.set('search', params.search);
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.offset) q.set('offset', String(params.offset));
    return request<PaginatedLogs>(`/logs?${q}`);
  },

  // Memories
  memories: (params?: MemoriesParams) => {
    const q = new URLSearchParams();
    if (params?.type) q.set('type', params.type);
    if (params?.project_path) q.set('project_path', params.project_path);
    if (params?.search) q.set('search', params.search);
    if (params?.tag) q.set('tag', params.tag);
    if (params?.limit) q.set('limit', String(params.limit));
    if (params?.offset) q.set('offset', String(params.offset));
    return request<PaginatedMemories>(`/memories?${q}`);
  },
  deleteMemory: (id: number) => request<void>(`/memories/${id}`, { method: 'DELETE' }),
  memoryTags: () => request<MemoryTag[]>('/memories/tags'),
  deleteMemoriesByTag: (tag: string) => request<{ deleted: number }>(`/memories/tag/${encodeURIComponent(tag)}`, { method: 'DELETE' }),

  // Permissions
  pendingPermissions: () => request<PendingPermission[]>('/permissions/pending'),
  respondPermission: (id: number, response: 'allow' | 'deny') =>
    request<{ ok: boolean }>(`/permissions/${id}/respond`, { method: 'POST', body: JSON.stringify({ response }) }),
  alwaysAllowPermission: (id: number) =>
    request<{ ok: boolean }>(`/permissions/${id}/always`, { method: 'POST', body: '{}' }),

  // Process health
  processHealth: () => request<ProcessHealthResponse>('/process-health'),
  restartDaemon: () => request<{ ok: boolean }>('/process-health/restart-daemon', { method: 'POST', body: '{}' }),
  restartDockerContainer: (container: string) =>
    request<{ ok: boolean }>('/process-health/restart-docker', { method: 'POST', body: JSON.stringify({ container }) }),

  // Projects
  projects: () => request<Project[]>('/projects'),
  createProject: (data: { name: string; path: string }) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  startProject: (id: number) => request<{ ok: boolean }>(`/projects/${id}/start`, { method: 'POST' }),
  stopProject: (id: number) => request<{ ok: boolean }>(`/projects/${id}/stop`, { method: 'POST' }),
  deleteProject: (id: number) => request<{ ok: boolean }>(`/projects/${id}`, { method: 'DELETE' }),

  // --- Agents / Tasks / Models (PRD §16, wired to wave-6 endpoints) ---
  agents: (params?: { project_id?: number; desired_state?: string; actual_state?: string }) => {
    const q = new URLSearchParams();
    if (params?.project_id != null) q.set('project_id', String(params.project_id));
    if (params?.desired_state) q.set('desired_state', params.desired_state);
    if (params?.actual_state) q.set('actual_state', params.actual_state);
    return request<AgentInstanceRow[]>(`/agents${q.toString() ? '?' + q.toString() : ''}`);
  },
  agentDefinitions: () => request<AgentDefinitionRow[]>('/agents/definitions'),
  agentDetail: (id: number) => request<AgentInstanceRow>(`/agents/${id}`),
  agentEvents: (id: number, limit = 50) =>
    request<AgentEventRow[]>(`/agents/${id}/events?limit=${limit}`),
  agentAction: (id: number, action: 'start' | 'stop' | 'restart', reason?: string) =>
    request<AgentInstanceRow>(`/agents/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason ?? `dashboard ${action}` }),
    }),

  tasks: (params?: { status?: string; agent_instance_id?: number; parent_task_id?: number | 'null' }) => {
    const q = new URLSearchParams();
    if (params?.status) q.set('status', params.status);
    if (params?.agent_instance_id != null) q.set('agent_instance_id', String(params.agent_instance_id));
    if (params?.parent_task_id != null) q.set('parent_task_id', String(params.parent_task_id));
    return request<AgentTaskRow[]>(`/tasks${q.toString() ? '?' + q.toString() : ''}`);
  },
  taskTree: (id: number) => request<AgentTaskRow & { children?: AgentTaskRow[] }>(`/tasks/${id}`),
  reassignTask: (id: number, reason?: string) =>
    request<{ task: AgentTaskRow; outcome: string; newAgentInstanceId: number | null; attempts: number }>(
      `/tasks/${id}/reassign`,
      { method: 'POST', body: JSON.stringify({ reason: reason ?? 'manual reassign from dashboard' }) },
    ),

  modelProviders: () => request<ModelProviderRow[]>('/providers'),
  modelProfiles: () => request<ModelProfileRow[]>('/profiles'),

  runtimeStatus: () => request<RuntimeStatusResponse>('/runtime/status'),
};

// Types

export interface AuthUser {
  id: number;
  first_name: string;
  username?: string;
  photo_url?: string;
}

export interface TelegramLoginData {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  photo_url?: string;
  auth_date: number;
  hash: string;
}

export interface Overview {
  uptime: number;
  db: string;
  transport: string;
  sessions: { active: number; total: number };
  tokens24h: { input: number; output: number; total: number; requests: number };
  recentSessions: Session[];
}

export interface Session {
  id: number;
  name: string | null;
  project_path: string | null;
  source: 'remote' | 'local' | 'standalone';
  status: string;
  connected_at: string;
  last_active: string;
}

export interface SessionDetail extends Session {
  client_id: string;
  metadata: Record<string, unknown>;
  message_count: number;
}

export interface Message {
  id: number;
  role: string;
  content: string;
  created_at: string;
}

export interface PaginatedMessages {
  messages: Message[];
  total: number;
}

export interface Stats {
  api: Record<string, {
    summary: {
      total: number;
      success: number;
      errors: number;
      input_tokens: number;
      output_tokens: number;
      total_tokens: number;
      avg_latency_ms: number;
      estimated_cost: number;
    };
    byProvider: Array<{ provider: string; model: string; requests: number; input_tokens: number; output_tokens: number; tokens: number; avg_ms: number; cost: number }>;
    bySession: Array<{ session_id: number; session_name: string; project_path: string | null; requests: number; input_tokens: number; output_tokens: number; tokens: number; avg_ms: number }>;
    byProject: Array<{ project: string; requests: number; input_tokens: number; output_tokens: number; tokens: number; avg_ms: number; sessions: number }>;
    byOperation: Array<{ operation: string; requests: number; input_tokens: number; output_tokens: number; tokens: number; errors: number; avg_ms: number }>;
  }>;
  transcription: Record<string, {
    summary: { total: number; success: number; errors: number; avg_latency_ms: number };
    byProvider: Array<{ provider: string; requests: number; success: number; avg_ms: number }>;
  }>;
  messages: Record<string, {
    bySession: Array<{ session_id: number; session_name: string; total: number; user_msgs: number; assistant_msgs: number }>;
  }>;
}

export interface DailyStats {
  date: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  errors: number;
}

export interface LogEntry {
  id: number;
  session_id: number | null;
  session_name: string | null;
  level: string;
  stage: string;
  message: string;
  created_at: string;
}

export interface LogsParams {
  session_id?: number;
  level?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface PaginatedLogs {
  logs: LogEntry[];
  total: number;
}

export interface Memory {
  id: number;
  source: string;
  type: string;
  content: string;
  tags: string[];
  project_path: string | null;
  created_at: string;
}

export interface MemoriesParams {
  type?: string;
  project_path?: string;
  search?: string;
  tag?: string;
  limit?: number;
  offset?: number;
}

export interface PaginatedMemories {
  memories: Memory[];
  total: number;
  hotContext: Memory[];
  indexing: boolean;
}

export interface MemoryTag {
  tag: string;
  count: number;
}

export interface Project {
  id: number;
  name: string;
  path: string;
  tmux_session_name: string;
  created_at: string;
  session_id: number | null;
  session_status: string | null;
}

export interface PendingPermission {
  id: number;
  tool_name: string;
  description: string;
  status: string;
  created_at: string;
  session_id: number;
  session_name: string | null;
  project_path: string | null;
}

export interface ProcessHealthRow {
  name: string;
  status: string;
  detail: Record<string, unknown> | null;
  updated_at: string;
}

export interface ProcessHealthResponse {
  health: ProcessHealthRow[];
  activeSessionCount: number;
}

export interface ApiError {
  model: string;
  operation: string;
  error_message: string;
  duration_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  session_name: string | null;
  project_path: string | null;
  created_at: string;
}

// --- Agents / Tasks / Models (PRD §16) ---

export interface AgentDefinitionRow {
  id: number;
  name: string;
  description: string | null;
  runtimeType: string;
  runtimeDriver: string;
  modelProfileId: number | null;
  systemPrompt: string | null;
  capabilities: string[];
  config: Record<string, unknown>;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

// AgentInstanceRow comes from the raw-SQL list endpoint, so it's snake_case
// with definition/project columns joined in. Single-instance endpoint
// (handleGetAgent) routes through agentManager and returns camelCase —
// we coalesce in the UI layer to keep one type.
export interface AgentInstanceRow {
  id: number;
  definition_id: number;
  project_id: number | null;
  name: string;
  desired_state: 'running' | 'stopped' | 'paused' | string;
  actual_state: 'new' | 'running' | 'idle' | 'busy' | 'starting' | 'stopping' | 'stuck' | 'failed' | 'waiting_approval' | string;
  runtime_handle: Record<string, unknown>;
  last_snapshot: string | null;
  last_snapshot_at: string | null;
  last_health_at: string | null;
  restart_count: number;
  last_restart_at: string | null;
  session_id: number | null;
  created_at: string;
  updated_at: string;
  // Joined columns (only present on /api/agents list)
  definition_name?: string;
  runtime_type?: string;
  capabilities?: string[];
  definition_enabled?: boolean;
  project_name?: string | null;
  // camelCase variants from agentManager (single-instance endpoint)
  desiredState?: string;
  actualState?: string;
  definitionId?: number;
  projectId?: number | null;
}

export interface AgentEventRow {
  id: number;
  agent_instance_id: number;
  task_id: number | null;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  message: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

export interface AgentTaskRow {
  id: number;
  agentInstanceId: number | null;
  parentTaskId: number | null;
  title: string;
  description: string | null;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'waiting_approval' | string;
  priority: number;
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelProviderRow {
  id: number;
  name: string;
  provider_type: string;
  base_url: string | null;
  api_key_env: string | null;
  default_model: string | null;
  enabled: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ModelProfileRow {
  id: number;
  name: string;
  provider_id: number;
  provider_name: string;
  model: string;
  max_tokens: number | null;
  temperature: number | null;
  system_prompt: string | null;
  enabled: boolean;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface RuntimeStatusResponse {
  totals: {
    total_instances: number;
    running_instances: number;
    stopped_instances: number;
    waiting_approval: number;
    desired_actual_drift: number;
    pending_tasks: number;
    in_progress_tasks: number;
    failed_tasks: number;
  };
  drivers: Record<string, string>;
}
