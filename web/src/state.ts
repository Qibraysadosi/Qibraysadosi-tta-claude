// Global holat: ilova ma'lumoti, foydalanuvchi, loyihalar, sessiyalar va joriy suhbat ko'rinishi.
import { signal, computed, batch } from '@preact/signals';
import type { AgentDef, AppInfo, ChatEvent, LiveEvent, PermissionMode, Project, ResultFile, SessionInfo, SessionState, TodoItem, UserPublic } from '../../shared/protocol';
import { api, WsClient } from './api';
import { setLang } from './i18n';

export interface StreamBlock {
  type: string;
  text: string;
  partial_json: string;
  id?: string;
  name?: string;
  done: boolean;
}

export interface TaskView {
  task_id: string;
  status: string;
  description: string;
  subagent_type?: string;
  summary?: string;
  usage?: { total_tokens: number; tool_uses: number; duration_ms: number };
  ts: number;
}

export interface SessionView {
  id: string;
  info: SessionInfo | null;
  events: ChatEvent[];
  pending: Map<string, Extract<ChatEvent, { t: 'permission_request' }>>;
  resolved: Map<string, Extract<ChatEvent, { t: 'permission_resolved' }>>;
  results: Map<string, Extract<ChatEvent, { t: 'tool_result' }>>;
  todos: TodoItem[];
  tasks: Map<string, TaskView>;
  state: SessionState;
  mode: PermissionMode;
  model: string;
  status: 'compacting' | 'requesting' | null;
  stream: { blocks: StreamBlock[]; ended: boolean } | null;
  progress: Map<string, number>;
  loaded: boolean;
  files: ResultFile[];
  version: number; // har o'zgarishda oshadi (re-render uchun)
}

export const app = signal<AppInfo | null>(null);
export const user = signal<UserPublic | null>(null);
export const projects = signal<Project[]>([]);
export const sessions = signal<SessionInfo[]>([]);
export const agents = signal<AgentDef[]>([]);
export const route = signal<string>(location.hash.slice(1) || '/');
export const wsConnected = signal(true);
export const rightPanelOpen = signal(window.innerWidth > 900 && localStorage.getItem('tta.right') !== '0');
export const sidebarOpen = signal(window.innerWidth > 900);
export const toasts = signal<Array<{ id: number; text: string; kind: 'info' | 'error' | 'ok' }>>([]);
export const currentSession = signal<SessionView | null>(null);
export const composerDraft = signal('');
export const theme = signal<'light' | 'dark' | 'system'>((localStorage.getItem('tta.theme') as 'light' | 'dark' | 'system') || 'system');

export const isAdmin = computed(() => user.value?.role === 'admin');
export const isDesktop = computed(() => Boolean(app.value?.desktop));
export const projectById = computed(() => new Map(projects.value.map((p) => [p.id, p])));

export const ws = new WsClient();
ws.onStatus = (c) => (wsConnected.value = c);

window.addEventListener('hashchange', () => (route.value = location.hash.slice(1) || '/'));

export function navigate(path: string): void {
  if (location.hash.slice(1) === path) route.value = path;
  else location.hash = path;
}

let toastId = 0;
export function toast(text: string, kind: 'info' | 'error' | 'ok' = 'info'): void {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, text, kind }];
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 3000);
}

export function applyTheme(): void {
  const v = theme.value;
  const dark = v === 'dark' || (v === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  localStorage.setItem('tta.theme', v);
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

export async function loadApp(): Promise<void> {
  const info = await api.get<AppInfo & { user: UserPublic | null }>('/api/app');
  batch(() => {
    app.value = info;
    user.value = info.user;
    if (info.user) {
      setLang(info.user.lang);
      theme.value = info.user.theme;
    }
  });
  applyTheme();
  if (info.user) await loadUserData();
}

export async function loadUserData(): Promise<void> {
  const [p, s, a] = await Promise.all([api.get<{ projects: Project[] }>('/api/projects'), api.get<{ sessions: SessionInfo[] }>('/api/sessions'), api.get<{ agents: AgentDef[] }>('/api/agents')]);
  batch(() => {
    projects.value = p.projects;
    sessions.value = s.sessions;
    agents.value = a.agents;
  });
}

export async function refreshSessions(): Promise<void> {
  const s = await api.get<{ sessions: SessionInfo[] }>('/api/sessions');
  sessions.value = s.sessions;
}

export async function refreshProjects(): Promise<void> {
  const p = await api.get<{ projects: Project[] }>('/api/projects');
  projects.value = p.projects;
}

// ---------- suhbat ko'rinishi ----------

function emptyView(id: string): SessionView {
  return {
    id,
    info: null,
    events: [],
    pending: new Map(),
    resolved: new Map(),
    results: new Map(),
    todos: [],
    tasks: new Map(),
    state: 'idle',
    mode: 'auto',
    model: '',
    status: null,
    stream: null,
    progress: new Map(),
    loaded: false,
    files: [],
    version: 0,
  };
}

const views = new Map<string, SessionView>();

export function openSession(id: string): SessionView {
  let v = views.get(id);
  if (!v) {
    v = emptyView(id);
    views.set(id, v);
  }
  currentSession.value = v;
  ws.subscribe(id);
  return v;
}

export function closeSessionView(id: string): void {
  ws.unsubscribe(id);
  views.delete(id);
  if (currentSession.value?.id === id) currentSession.value = null;
}

function bump(v: SessionView): void {
  v.version++;
  if (currentSession.value?.id === v.id) currentSession.value = { ...v };
}

function applyChatEvent(v: SessionView, ev: ChatEvent): void {
  switch (ev.t) {
    case 'permission_request':
      v.pending.set(ev.request_id, ev);
      break;
    case 'permission_resolved':
      v.pending.delete(ev.request_id);
      v.resolved.set(ev.request_id, ev);
      break;
    case 'tool_result':
      v.results.set(ev.tool_use_id, ev);
      v.progress.delete(ev.tool_use_id);
      break;
    case 'todos':
      v.todos = ev.items;
      break;
    case 'task':
      v.tasks.set(ev.task_id, { ...(v.tasks.get(ev.task_id) ?? {}), ...ev, summary: ev.summary ?? v.tasks.get(ev.task_id)?.summary, usage: ev.usage ?? v.tasks.get(ev.task_id)?.usage });
      break;
    case 'files':
      v.files = ev.files;
      break;
    default:
      break;
  }
  if (ev.t !== 'todos' && ev.t !== 'files' && ev.t !== 'task') v.events.push(ev);
  else if (ev.t === 'task' && (ev.status === 'started' || ev.status === 'completed' || ev.status === 'failed' || ev.status === 'stopped')) v.events.push(ev);
}

function applyStream(v: SessionView, event: Record<string, unknown>, parent: string | null): void {
  if (parent) return; // yordamchi agentlarning oqimi ko'rsatilmaydi
  const type = event.type as string;
  if (type === 'message_start') {
    v.stream = { blocks: [], ended: false };
    return;
  }
  if (!v.stream) v.stream = { blocks: [], ended: false };
  const s = v.stream;
  if (type === 'content_block_start') {
    const cb = (event.content_block ?? {}) as { type: string; id?: string; name?: string; text?: string };
    s.blocks.push({ type: cb.type, text: cb.text ?? '', partial_json: '', id: cb.id, name: cb.name, done: false });
  } else if (type === 'content_block_delta') {
    const d = (event.delta ?? {}) as { type: string; text?: string; partial_json?: string; thinking?: string };
    const b = s.blocks[Number(event.index)] ?? s.blocks[s.blocks.length - 1];
    if (!b) return;
    if (d.type === 'text_delta') b.text += d.text ?? '';
    else if (d.type === 'input_json_delta') b.partial_json += d.partial_json ?? '';
    else if (d.type === 'thinking_delta') b.text += d.thinking ?? '';
  } else if (type === 'content_block_stop') {
    const b = s.blocks[Number(event.index)];
    if (b) b.done = true;
  } else if (type === 'message_stop') {
    s.ended = true;
  }
}

export function handleLive(ev: LiveEvent, sessionId?: string): void {
  if (!sessionId) {
    if (ev.t === 'error') toast(ev.message, 'error');
    return;
  }
  const v = views.get(sessionId);
  if (!v) return;
  switch (ev.t) {
    case 'history': {
      v.events = [];
      v.pending = new Map();
      v.resolved = new Map();
      v.results = new Map();
      v.tasks = new Map();
      v.todos = [];
      for (const e of ev.events) applyChatEvent(v, e);
      for (const p of ev.pending) if (p.t === 'permission_request') v.pending.set(p.request_id, p);
      v.loaded = true;
      v.stream = null;
      break;
    }
    case 'session':
      v.info = ev.session;
      v.mode = ev.session.mode;
      v.model = ev.session.model;
      v.files = ev.session.files;
      sessions.value = sessions.value.some((s) => s.id === ev.session.id) ? sessions.value.map((s) => (s.id === ev.session.id ? ev.session : s)) : [ev.session, ...sessions.value];
      break;
    case 'state':
      v.state = ev.state;
      if (ev.permissionMode) v.mode = ev.permissionMode;
      if (ev.model) v.model = ev.model;
      if (ev.state === 'idle') {
        v.stream = null;
        v.status = null;
        v.progress.clear();
      }
      break;
    case 'status':
      v.status = ev.status;
      break;
    case 'stream':
      applyStream(v, ev.event as Record<string, unknown>, ev.parent_tool_use_id);
      break;
    case 'tool_progress':
      v.progress.set(ev.tool_use_id, ev.elapsed);
      break;
    case 'assistant': {
      // Oqimdagi tugallangan bloklarni yakuniy xabar bilan almashtiramiz
      if (v.stream && !ev.parent_tool_use_id) {
        const n = ev.blocks.length;
        v.stream.blocks.splice(0, n);
        if (v.stream.blocks.length === 0 && v.stream.ended) v.stream = null;
      }
      applyChatEvent(v, ev);
      break;
    }
    case 'result':
      v.stream = null;
      v.status = null;
      applyChatEvent(v, ev);
      break;
    case 'error':
      toast(ev.message, 'error');
      break;
    case 'todos':
      v.todos = ev.items;
      break;
    default:
      applyChatEvent(v, ev);
  }
  bump(v);
}

ws.listen(handleLive);
