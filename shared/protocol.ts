// Mijoz ↔ server protokoli: REST javoblari va WebSocket hodisalari.
// Bu fayl server (Node) va web (brauzer) tomonidan birgalikda ishlatiladi.

export type Role = 'admin' | 'member';
export type Lang = 'uz' | 'ru';
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'auto' | 'bypassPermissions';

export interface UserPublic {
  id: string;
  login: string;
  name: string;
  role: Role;
  lang: Lang;
  theme: 'light' | 'dark' | 'system';
  active: boolean;
  monthly_limit_usd: number | null;
  instructions: string;
  default_model: string;
  default_mode: PermissionMode;
  created: number;
  must_change_password?: boolean;
}

export interface Project {
  id: string;
  user_id: string;
  name: string;
  path: string;
  kind: 'workspace' | 'folder';
  created: number;
  updated: number;
  instructions_note?: string;
}

export interface SessionInfo {
  id: string;
  user_id: string;
  project_id: string;
  title: string;
  created: number;
  updated: number;
  model: string;
  mode: PermissionMode;
  agent: string | null;
  cost_usd: number;
  turns: number;
  pinned: boolean;
  archived: boolean;
  origin: 'chat' | 'schedule';
  state: SessionState;
  sdk_session_id: string | null;
  files: ResultFile[];
  stats: SessionStats;
}

export type SessionState = 'idle' | 'running' | 'requires_action' | 'error';

export interface SessionStats {
  web_searches: number;
  tool_uses: number;
  uploads: number;
  input_tokens: number;
  output_tokens: number;
  context_tokens: number;
  context_window: number;
}

export interface ResultFile {
  path: string; // loyiha papkasiga nisbatan
  name: string;
  size: number;
  mtime: number;
  kind: 'created' | 'modified' | 'uploaded';
}

export interface AgentDef {
  id: string;
  user_id: string | null; // null = hamma uchun (admin yaratgan)
  name: string; // lotin harf/raqam/-
  title: string;
  description: string;
  prompt: string;
  tools: string[]; // bo'sh = hammasi
  model: string; // '' = asosiy modeldan meros
  color: string;
  created: number;
  updated: number;
}

export interface Schedule {
  id: string;
  user_id: string;
  project_id: string;
  title: string;
  prompt: string;
  model: string;
  mode: PermissionMode;
  spec: ScheduleSpec;
  enabled: boolean;
  last_run: number | null;
  last_session_id: string | null;
  last_status: 'ok' | 'error' | null;
  next_run: number | null;
  created: number;
  max_budget_usd: number;
}

export type ScheduleSpec =
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; days: number[]; time: string }
  | { kind: 'interval'; minutes: number }
  | { kind: 'once'; at: number };

export interface ModelOption {
  value: string;
  label: string;
  description: string;
}

export interface TodoItem {
  id?: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export interface Attachment {
  path: string; // loyiha ichidagi nisbiy yo'l
  name: string;
  size: number;
  mime: string;
  image?: boolean;
}

// ---- Suhbat hodisalari (saqlanadi va jonli yuboriladi) ----

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }
  | { type: 'image'; source: unknown }
  | { type: string; [k: string]: unknown };

export type ChatEvent =
  | { t: 'user'; id: string; text: string; attachments: Attachment[]; ts: number; by: string }
  | {
      t: 'assistant';
      id: string;
      blocks: ContentBlock[];
      model: string;
      ts: number;
      parent_tool_use_id: string | null;
      agent_id?: string;
      error?: string;
      aborted?: boolean;
    }
  | {
      t: 'tool_result';
      tool_use_id: string;
      content: unknown;
      is_error: boolean;
      ts: number;
      parent_tool_use_id: string | null;
      structured?: unknown;
    }
  | {
      t: 'result';
      ts: number;
      subtype: string;
      is_error: boolean;
      cost_total: number;
      cost_delta: number;
      duration_ms: number;
      num_turns: number;
      errors?: string[];
      text?: string;
    }
  | {
      t: 'permission_request';
      request_id: string;
      tool: string;
      input: unknown;
      ts: number;
      reason?: string;
      suggestions?: unknown[];
      agent_id?: string;
      blocked_path?: string;
    }
  | { t: 'permission_resolved'; request_id: string; behavior: 'allow' | 'deny'; by: string; ts: number; note?: string }
  | {
      t: 'task';
      task_id: string;
      status: 'started' | 'progress' | 'completed' | 'failed' | 'stopped';
      description: string;
      subagent_type?: string;
      summary?: string;
      usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
      ts: number;
    }
  | { t: 'system'; kind: 'error' | 'info' | 'warning'; text: string; ts: number }
  | { t: 'init'; ts: number; sdk_session_id: string; model: string; permissionMode: string; tools: string[]; cwd: string; version: string }
  | { t: 'todos'; items: TodoItem[]; ts: number }
  | { t: 'files'; files: ResultFile[]; ts: number };

// Jonli (saqlanmaydigan) hodisalar
export type LiveEvent =
  | ChatEvent
  | { t: 'stream'; event: unknown; parent_tool_use_id: string | null }
  | { t: 'state'; state: SessionState; permissionMode?: PermissionMode; model?: string }
  | { t: 'status'; status: 'compacting' | 'requesting' | null }
  | { t: 'tool_progress'; tool_use_id: string; tool_name: string; elapsed: number }
  | { t: 'session'; session: SessionInfo }
  | { t: 'history'; events: ChatEvent[]; pending: ChatEvent[] }
  | { t: 'error'; code: string; message: string };

// Mijozdan serverga
export type ClientMessage =
  | { a: 'subscribe'; session_id: string }
  | { a: 'unsubscribe'; session_id: string }
  | { a: 'send'; session_id: string; text: string; attachments?: Attachment[]; client_id?: string }
  | { a: 'interrupt'; session_id: string }
  | {
      a: 'permission';
      session_id: string;
      request_id: string;
      behavior: 'allow' | 'deny';
      always?: boolean;
      message?: string;
      updated_input?: unknown;
    }
  | { a: 'set_mode'; session_id: string; mode: PermissionMode }
  | { a: 'set_model'; session_id: string; model: string }
  | { a: 'ping' };

export interface ServerEnvelope {
  session_id?: string;
  ev: LiveEvent;
}

export interface AppInfo {
  name: string;
  version: string;
  desktop: boolean;
  base_path: string;
  models: ModelOption[];
  api_key_set: boolean;
  default_model: string;
  setup_required: boolean;
}
