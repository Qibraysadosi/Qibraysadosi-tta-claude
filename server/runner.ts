// Bitta suhbat (sessiya) uchun agent jarayoni: xabar yuborish, SDK oqimini mijoz hodisalariga
// aylantirish, ruxsat so'rovlarini kutish, narx hisobi, tarixni JSONL'ga yozish.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppConfig } from './config.js';
import type { Store, UserRecord } from './store.js';
import type { Engine, EngineHandle, SDKMessage, SDKUserMessage, AgentDefinition } from './engine.js';
import type { PermissionUpdate } from '@anthropic-ai/claude-agent-sdk';
import type {
  Attachment,
  ChatEvent,
  LiveEvent,
  PermissionMode,
  Project,
  ResultFile,
  SessionInfo,
  SessionState,
  TodoItem,
} from '../shared/protocol.js';
import { ensureDir, isImageName, mimeOf, safeResolve, scanChanged, statFile } from './files.js';

export interface RunnerContext {
  engine: Engine;
  store: Store;
  config: AppConfig;
  emit: (sessionId: string, ev: LiveEvent) => void;
  envForUser: (user: UserRecord) => Record<string, string | undefined>;
  agentsForUser: (user: UserRecord) => Record<string, AgentDefinition>;
  systemPromptFor: (user: UserRecord, project: Project) => string;
  log: (msg: string, ...rest: unknown[]) => void;
}

interface PendingPermission {
  ev: Extract<ChatEvent, { t: 'permission_request' }>;
  resolve: (r: PermissionResultLike) => void;
  suggestions: unknown[];
}

type PermissionResultLike =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: PermissionUpdate[] }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

// claude.ai ga xos, bu ilovada ma'nosiz vositalar.
export const DISALLOWED_TOOLS = [
  'Artifact',
  'ClaudeDesign',
  'OfferChromeSetup',
  'ShareOnboardingGuide',
  'ShowOnboardingRolePicker',
  'SendFeedback',
  'propose_skills',
  'PushNotification',
  'RemoteTrigger',
  'Projects',
  'EndConversation',
  'ProposeGoal',
  'SendUserFile',
  'SendUserMessage',
  'ReadNotifications',
  'ScheduleWakeup',
  'CronCreate',
  'CronDelete',
  'CronList',
  'EnterWorktree',
  'ExitWorktree',
  'Workflow',
  'Monitor',
  'ListAgents',
  'SendMessage',
];

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export class SessionRunner {
  private handle: EngineHandle | null = null;
  private abort: AbortController | null = null;
  private pending = new Map<string, PendingPermission>();
  private idleTimer: NodeJS.Timeout | null = null;
  private turnStart = 0;
  private running = false;
  private closing = false;
  private loopDone: Promise<void> | null = null;
  private historyPath: string;
  private sessionAllowed = new Set<string>(); // "always" tanlangan vosita nomlari (sessiya ichida)
  public todos: TodoItem[] = [];
  public state: SessionState = 'idle';
  private sdkMode: PermissionMode;
  private resumeId: string | null;
  private fileTouched = new Map<string, number>();
  private queuedTurns = 0;
  /** Rejali (so'ralmaydigan) ish: ruxsat so'rovlari avtomatik rad etiladi, byudjet/qadam chegarasi bor. */
  public headless: { maxBudgetUsd: number; maxTurns: number } | null = null;
  public lastResultOk = false;
  private idleWaiters: Array<() => void> = [];

  constructor(
    private ctx: RunnerContext,
    public session: SessionInfo,
    public project: Project,
    public user: UserRecord,
  ) {
    const dir = path.join(ctx.config.dataDir, 'users', user.id, 'sessions');
    ensureDir(dir);
    this.historyPath = path.join(dir, session.id + '.jsonl');
    this.sdkMode = session.mode;
    this.resumeId = session.sdk_session_id;
    // oldingi vazifalar ro'yxatini tarixdan tiklaymiz
    for (const ev of this.history()) {
      if (ev.t === 'todos') this.todos = ev.items;
    }
  }

  // ---------- tarix ----------

  history(): ChatEvent[] {
    try {
      const out: ChatEvent[] = [];
      for (const line of fs.readFileSync(this.historyPath, 'utf8').split('\n')) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line) as ChatEvent);
        } catch {
          /* buzilgan qator */
        }
      }
      return out;
    } catch {
      return [];
    }
  }

  pendingEvents(): ChatEvent[] {
    return [...this.pending.values()].map((p) => p.ev);
  }

  private persist(ev: ChatEvent): void {
    fs.appendFileSync(this.historyPath, JSON.stringify(ev) + '\n');
  }

  private emit(ev: LiveEvent, persist = false): void {
    if (persist) this.persist(ev as ChatEvent);
    this.ctx.emit(this.session.id, ev);
  }

  private setState(state: SessionState): void {
    if (this.state === state) return;
    this.state = state;
    this.session = this.ctx.store.sessions.update(this.session.id, { state }) ?? this.session;
    this.emit({ t: 'state', state, permissionMode: this.sdkMode, model: this.session.model });
    if (state === 'idle' || state === 'error') {
      for (const w of this.idleWaiters.splice(0)) w();
    }
  }

  /** Jarayon tugashini kutish (rejali vazifalar uchun). */
  waitIdle(timeoutMs: number): Promise<void> {
    if (!this.running && this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        void this.interrupt();
        resolve();
      }, timeoutMs);
      this.idleWaiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  private touchSession(patch: Partial<SessionInfo>): void {
    this.session = this.ctx.store.sessions.update(this.session.id, { ...patch, updated: Date.now() }) ?? this.session;
    this.emit({ t: 'session', session: this.session });
  }

  // ---------- ishga tushirish ----------

  get active(): boolean {
    return this.handle !== null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  private start(): void {
    const { config } = this.ctx;
    this.abort = new AbortController();
    const agents = this.ctx.agentsForUser(this.user);
    const env = this.ctx.envForUser(this.user);
    const bypass = this.sdkMode === 'bypassPermissions';
    this.handle = this.ctx.engine.start({
      cwd: this.project.path,
      model: this.session.model,
      permissionMode: this.sdkMode,
      allowDangerouslySkipPermissions: bypass,
      resume: this.resumeId ?? undefined,
      systemPromptAppend: this.ctx.systemPromptFor(this.user, this.project),
      agents: Object.keys(agents).length ? agents : undefined,
      agent: this.session.agent && agents[this.session.agent] ? this.session.agent : undefined,
      env,
      disallowedTools: DISALLOWED_TOOLS,
      canUseTool: (toolName, input, options) => this.onPermission(toolName, input, options),
      abortController: this.abort,
      claudeBinary: config.claudeBinary,
      maxBudgetUsd: this.headless ? Math.min(this.headless.maxBudgetUsd, this.budgetLeft() ?? Infinity) : this.budgetLeft(),
      maxTurns: this.headless?.maxTurns,
      permissionPrompts: this.headless ? 'none' : 'host',
      stderr: (d) => {
        const line = d.trim();
        if (line) this.ctx.log(`[sdk ${this.session.id.slice(0, 6)}] ${line.slice(0, 500)}`);
      },
    });
    const handle = this.handle;
    this.loopDone = this.loop(handle).catch((err: unknown) => {
      this.ctx.log('[runner] oqim xatosi', err);
      this.emit({ t: 'system', kind: 'error', text: 'Agent jarayoni xato bilan tugadi: ' + String((err as Error)?.message ?? err), ts: Date.now() }, true);
    }).finally(() => {
      if (this.handle === handle) this.handle = null;
      this.failPending('Jarayon tugadi');
      this.running = false;
      this.setState(this.state === 'error' ? 'error' : 'idle');
    });
  }

  private budgetLeft(): number | undefined {
    const limit = this.user.monthly_limit_usd;
    if (!limit) return undefined;
    const since = new Date();
    since.setDate(1);
    since.setHours(0, 0, 0, 0);
    const spent = this.ctx.store.readUsage(since.getTime()).filter((u) => u.user_id === this.user.id).reduce((a, b) => a + b.cost_usd, 0);
    return Math.max(0.05, limit - spent);
  }

  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.running && this.pending.size === 0) void this.close('idle');
      else this.resetIdle();
    }, this.ctx.config.idleCloseMs);
  }

  // ---------- foydalanuvchi harakatlari ----------

  async send(text: string, attachments: Attachment[], by: string): Promise<void> {
    const ts = Date.now();
    const id = crypto.randomBytes(6).toString('hex');
    const ev: ChatEvent = { t: 'user', id, text, attachments, ts, by };
    this.persist(ev);
    this.emit(ev);
    this.session.stats.uploads += attachments.length;
    if (!this.handle) this.start();
    this.turnStart = ts;
    this.running = true;
    this.setState('running');
    this.resetIdle();
    if (this.session.turns === 0 && !this.session.title) {
      this.touchSession({ title: text.slice(0, 80) || attachments[0]?.name || 'Yangi suhbat' });
    }
    this.handle!.push(this.buildUserMessage(text, attachments));
  }

  private buildUserMessage(text: string, attachments: Attachment[]): SDKUserMessage {
    const content: Array<Record<string, unknown>> = [];
    let body = text;
    if (attachments.length) {
      const lines = attachments.map((a) => `- ${a.name} → ${safeResolve(this.project.path, a.path)}`);
      body += `\n\n[Biriktirilgan fayllar (loyiha papkasida):\n${lines.join('\n')}]`;
    }
    for (const a of attachments) {
      if (!a.image || !isImageName(a.name)) continue;
      try {
        const abs = safeResolve(this.project.path, a.path);
        const st = fs.statSync(abs);
        if (st.size > 5 * 1024 * 1024) continue;
        const data = fs.readFileSync(abs).toString('base64');
        content.push({ type: 'image', source: { type: 'base64', media_type: mimeOf(a.name).split(';')[0], data } });
      } catch {
        /* rasm o'qilmadi — matnda yo'li qoladi */
      }
    }
    content.push({ type: 'text', text: body || '(bo\'sh xabar)' });
    return {
      type: 'user',
      message: { role: 'user', content: content as never },
      parent_tool_use_id: null,
    } as SDKUserMessage;
  }

  async interrupt(): Promise<void> {
    if (!this.handle) return;
    try {
      await this.handle.interrupt();
    } catch (e) {
      this.ctx.log('[runner] interrupt', e);
    }
  }

  async setMode(mode: PermissionMode): Promise<void> {
    if (mode === 'bypassPermissions' && !(this.ctx.config.allowBypass && this.user.role === 'admin')) return;
    this.sdkMode = mode;
    this.touchSession({ mode });
    if (this.handle) {
      try {
        await this.handle.setPermissionMode(mode);
      } catch (e) {
        this.ctx.log('[runner] setPermissionMode', e);
      }
    }
    this.emit({ t: 'state', state: this.state, permissionMode: mode, model: this.session.model });
  }

  async setModel(model: string): Promise<void> {
    this.touchSession({ model });
    if (this.handle) {
      try {
        await this.handle.setModel(model);
      } catch (e) {
        this.ctx.log('[runner] setModel', e);
      }
    }
    this.emit({ t: 'state', state: this.state, permissionMode: this.sdkMode, model });
  }

  answerPermission(requestId: string, behavior: 'allow' | 'deny', opts: { always?: boolean; message?: string; updatedInput?: unknown; by: string }): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    this.pending.delete(requestId);
    const resolved: ChatEvent = { t: 'permission_resolved', request_id: requestId, behavior, by: opts.by, ts: Date.now(), note: opts.message };
    this.emit(resolved, true);
    if (behavior === 'allow') {
      const updatedInput = (opts.updatedInput && typeof opts.updatedInput === 'object' ? opts.updatedInput : p.ev.input) as Record<string, unknown>;
      let updatedPermissions: PermissionUpdate[] | undefined;
      if (opts.always) {
        this.sessionAllowed.add(p.ev.tool);
        const sessionSuggestions = (p.suggestions as PermissionUpdate[]).filter((s) => s.destination === 'session');
        updatedPermissions = sessionSuggestions.length
          ? sessionSuggestions
          : [{ type: 'addRules', rules: [{ toolName: p.ev.tool }], behavior: 'allow', destination: 'session' }];
      }
      p.resolve({ behavior: 'allow', updatedInput, updatedPermissions });
    } else {
      p.resolve({ behavior: 'deny', message: opts.message || 'Foydalanuvchi rad etdi' });
    }
    if (this.pending.size === 0 && this.state === 'requires_action') this.setState('running');
    return true;
  }

  private failPending(reason: string): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.resolve({ behavior: 'deny', message: reason });
      this.emit({ t: 'permission_resolved', request_id: id, behavior: 'deny', by: 'system', ts: Date.now(), note: reason }, true);
    }
  }

  private onPermission(
    toolName: string,
    input: Record<string, unknown>,
    options: { signal: AbortSignal; suggestions?: unknown[]; decisionReason?: string; toolUseID: string; agentID?: string; requestId?: string; blockedPath?: string },
  ): Promise<PermissionResultLike> {
    // "Doim ruxsat" tanlangan vosita bo'lsa — so'ramaymiz.
    if (this.sessionAllowed.has(toolName) && toolName !== 'AskUserQuestion' && toolName !== 'ExitPlanMode') {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const requestId = options.requestId || options.toolUseID || crypto.randomBytes(6).toString('hex');
    const ev: Extract<ChatEvent, { t: 'permission_request' }> = {
      t: 'permission_request',
      request_id: requestId,
      tool: toolName,
      input,
      ts: Date.now(),
      reason: options.decisionReason,
      agent_id: options.agentID,
      blocked_path: options.blockedPath,
    };
    this.persist(ev);
    this.emit(ev);
    this.setState('requires_action');
    this.resetIdle();
    return new Promise<PermissionResultLike>((resolve) => {
      this.pending.set(requestId, { ev, resolve, suggestions: options.suggestions ?? [] });
      options.signal.addEventListener('abort', () => {
        if (this.pending.has(requestId)) {
          this.pending.delete(requestId);
          resolve({ behavior: 'deny', message: 'Bekor qilindi' });
          this.emit({ t: 'permission_resolved', request_id: requestId, behavior: 'deny', by: 'system', ts: Date.now(), note: 'bekor' }, true);
          if (this.pending.size === 0 && this.state === 'requires_action') this.setState(this.running ? 'running' : 'idle');
        }
      });
    });
  }

  // ---------- SDK oqimi ----------

  private async loop(handle: EngineHandle): Promise<void> {
    for await (const m of handle.messages) {
      if (this.closing) break;
      try {
        this.onMessage(m as SDKMessage & Record<string, unknown>);
      } catch (e) {
        this.ctx.log('[runner] xabarni qayta ishlashda xato', e);
      }
    }
  }

  private onMessage(m: SDKMessage & Record<string, unknown>): void {
    const ts = Date.now();
    switch (m.type) {
      case 'system': {
        const sub = (m as { subtype: string }).subtype;
        if (sub === 'init') {
          const init = m as unknown as { session_id: string; model: string; permissionMode: string; tools: string[]; cwd: string; claude_code_version: string };
          const first = this.resumeId !== init.session_id;
          this.resumeId = init.session_id;
          if (this.session.sdk_session_id !== init.session_id) this.touchSession({ sdk_session_id: init.session_id });
          if (first) {
            this.emit(
              { t: 'init', ts, sdk_session_id: init.session_id, model: init.model, permissionMode: init.permissionMode, tools: init.tools ?? [], cwd: init.cwd, version: init.claude_code_version },
              true,
            );
          }
        } else if (sub === 'status') {
          const s = m as unknown as { status: 'compacting' | 'requesting' | null; permissionMode?: PermissionMode };
          this.emit({ t: 'status', status: s.status ?? null });
          if (s.permissionMode && s.permissionMode !== this.sdkMode) {
            this.sdkMode = s.permissionMode;
            this.touchSession({ mode: s.permissionMode });
            this.emit({ t: 'state', state: this.state, permissionMode: s.permissionMode, model: this.session.model });
          }
        } else if (sub === 'task_started' || sub === 'task_progress' || sub === 'task_notification' || sub === 'task_updated') {
          this.onTask(sub, m as unknown as Record<string, unknown>, ts);
        } else if (sub === 'permission_denied') {
          const d = m as unknown as { tool_name: string; message: string };
          this.emit({ t: 'system', kind: 'warning', text: `Ruxsat rad etildi: ${d.tool_name} — ${d.message ?? ''}`, ts }, true);
        } else if (sub === 'compact_boundary') {
          this.emit({ t: 'system', kind: 'info', text: 'Suhbat konteksti siqildi (eski qismlar qisqartirildi).', ts }, true);
        } else if (sub === 'session_state_changed') {
          const st = (m as unknown as { state: SessionState }).state;
          if (st === 'running' || st === 'requires_action') this.setState(st);
          else if (st === 'idle' && !this.running) this.setState('idle');
        } else if (sub === 'api_retry') {
          const r = m as unknown as { attempt?: number; max_retries?: number; error_status?: number };
          this.emit({ t: 'status', status: 'requesting' });
          if ((r.attempt ?? 0) >= 2) this.emit({ t: 'system', kind: 'info', text: `API qayta urinish ${r.attempt}/${r.max_retries ?? '?'} (${r.error_status ?? ''})`, ts });
        }
        break;
      }
      case 'stream_event': {
        const s = m as unknown as { event: unknown; parent_tool_use_id: string | null };
        this.emit({ t: 'stream', event: s.event, parent_tool_use_id: s.parent_tool_use_id });
        break;
      }
      case 'assistant': {
        const a = m as unknown as {
          uuid: string;
          message: { id: string; content: Array<Record<string, unknown>>; model: string };
          parent_tool_use_id: string | null;
          agent_id?: string;
          error?: string;
          aborted?: true;
        };
        const blocks = (a.message?.content ?? []) as Array<Record<string, unknown>>;
        for (const b of blocks) {
          if (b.type === 'tool_use') this.onToolUse(b as { id: string; name: string; input: Record<string, unknown> }, ts);
        }
        this.emit(
          {
            t: 'assistant',
            id: a.uuid,
            blocks: blocks as never,
            model: a.message?.model ?? this.session.model,
            ts,
            parent_tool_use_id: a.parent_tool_use_id ?? null,
            agent_id: a.agent_id,
            error: a.error,
            aborted: a.aborted,
          },
          true,
        );
        if (a.error) {
          this.emit({ t: 'system', kind: 'error', text: describeApiError(a.error), ts }, true);
        }
        break;
      }
      case 'user': {
        const u = m as unknown as { message: { content: unknown }; parent_tool_use_id: string | null; tool_use_result?: unknown; isSynthetic?: boolean };
        const content = u.message?.content;
        if (!Array.isArray(content)) break;
        for (const b of content as Array<Record<string, unknown>>) {
          if (b.type !== 'tool_result') continue;
          this.emit(
            {
              t: 'tool_result',
              tool_use_id: String(b.tool_use_id),
              content: b.content,
              is_error: Boolean(b.is_error),
              ts,
              parent_tool_use_id: u.parent_tool_use_id ?? null,
              structured: summarizeStructured(u.tool_use_result),
            },
            true,
          );
        }
        break;
      }
      case 'result': {
        this.onResult(m as unknown as Record<string, unknown>, ts);
        break;
      }
      case 'tool_progress': {
        const p = m as unknown as { tool_use_id: string; tool_name: string; elapsed_time_seconds: number };
        this.emit({ t: 'tool_progress', tool_use_id: p.tool_use_id, tool_name: p.tool_name, elapsed: p.elapsed_time_seconds });
        break;
      }
      default:
        break;
    }
  }

  private onToolUse(b: { id: string; name: string; input: Record<string, unknown> }, ts: number): void {
    this.session.stats.tool_uses += 1;
    if (b.name === 'WebSearch') this.session.stats.web_searches += 1;
    if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) {
      this.todos = (b.input.todos as TodoItem[]).map((t) => ({ content: String(t.content ?? ''), status: t.status ?? 'pending', activeForm: t.activeForm }));
      this.emit({ t: 'todos', items: this.todos, ts }, true);
    }
    if (FILE_TOOLS.has(b.name) && typeof b.input?.file_path === 'string') {
      this.fileTouched.set(b.input.file_path, ts);
    }
  }

  private onTask(sub: string, m: Record<string, unknown>, ts: number): void {
    const status =
      sub === 'task_started' ? 'started' : sub === 'task_progress' ? 'progress' : sub === 'task_updated' ? taskPatchStatus(m) : ((m.status as string) ?? 'completed');
    if (!status) return;
    const ev: ChatEvent = {
      t: 'task',
      task_id: String(m.task_id),
      status: status as 'started' | 'progress' | 'completed' | 'failed' | 'stopped',
      description: String(m.description ?? ''),
      subagent_type: m.subagent_type as string | undefined,
      summary: m.summary as string | undefined,
      usage: m.usage as { total_tokens: number; tool_uses: number; duration_ms: number } | undefined,
      ts,
    };
    this.emit(ev, status !== 'progress');
  }

  private onResult(r: Record<string, unknown>, ts: number): void {
    const total = Number(r.total_cost_usd ?? 0);
    const prev = this.session.cost_usd;
    const delta = total >= prev ? total - prev : total;
    const usage = (r.usage ?? {}) as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
    const modelUsage = (r.modelUsage ?? {}) as Record<string, { webSearchRequests?: number; contextWindow?: number; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number }>;
    const inTok = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
    const outTok = usage.output_tokens ?? 0;
    let ctxWindow = 0;
    for (const mu of Object.values(modelUsage)) ctxWindow = Math.max(ctxWindow, mu.contextWindow ?? 0);
    const stats = {
      ...this.session.stats,
      input_tokens: this.session.stats.input_tokens + inTok,
      output_tokens: this.session.stats.output_tokens + outTok,
      context_tokens: inTok + outTok,
      context_window: ctxWindow || this.session.stats.context_window,
    };
    const isError = Boolean(r.is_error);
    const subtype = String(r.subtype ?? 'success');
    this.lastResultOk = !isError && subtype === 'success';
    const errors = Array.isArray(r.errors) ? (r.errors as string[]) : undefined;
    const queued = Number(r.queued_turn_count ?? 0);
    this.queuedTurns = queued;
    if (delta > 0) {
      this.ctx.store.addUsage({ ts, user_id: this.user.id, session_id: this.session.id, cost_usd: delta, input_tokens: inTok, output_tokens: outTok, model: this.session.model });
    }
    const files = this.collectFiles();
    this.touchSession({ cost_usd: Math.max(prev, total), turns: this.session.turns + 1, stats, files, state: queued > 0 ? 'running' : 'idle' });
    this.emit(
      {
        t: 'result',
        ts,
        subtype,
        is_error: isError,
        cost_total: Math.max(prev, total),
        cost_delta: delta,
        duration_ms: Number(r.duration_ms ?? 0),
        num_turns: Number(r.num_turns ?? 0),
        errors,
        text: isError ? String(r.result ?? '').slice(0, 2000) : undefined,
      },
      true,
    );
    if (files.length) this.emit({ t: 'files', files, ts }, true);
    if (subtype !== 'success') {
      const txt = subtype === 'error_max_budget_usd' ? 'Byudjet chegarasiga yetildi.' : subtype === 'error_max_turns' ? 'Qadamlar chegarasiga yetildi.' : 'Jarayon xato bilan to\'xtadi.';
      this.emit({ t: 'system', kind: 'error', text: txt + (errors?.length ? ' ' + errors.join('; ').slice(0, 500) : ''), ts }, true);
    }
    if (queued === 0) {
      this.running = false;
      this.setState('idle');
    }
    this.resetIdle();
  }

  private collectFiles(): ResultFile[] {
    const root = this.project.path;
    const map = new Map<string, ResultFile>();
    for (const f of this.session.files) map.set(f.path, f);
    for (const [abs, t] of this.fileTouched) {
      let rel: string;
      try {
        rel = path.relative(path.resolve(root), path.resolve(abs)).split(path.sep).join('/');
      } catch {
        continue;
      }
      if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
      const st = statFile(root, rel);
      if (st) map.set(rel, { ...st, kind: map.has(rel) ? map.get(rel)!.kind : t >= this.turnStart ? 'created' : 'modified' });
    }
    this.fileTouched.clear();
    if (this.turnStart) {
      for (const f of scanChanged(root, this.turnStart)) {
        if (f.path.startsWith('uploads/')) continue;
        if (!map.has(f.path)) map.set(f.path, f);
        else map.set(f.path, { ...map.get(f.path)!, size: f.size, mtime: f.mtime });
      }
    }
    return [...map.values()].sort((a, b) => b.mtime - a.mtime).slice(0, 100);
  }

  // ---------- yopish ----------

  async close(reason: string): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (!this.handle) return;
    this.closing = true;
    this.ctx.log(`[runner] yopilmoqda (${reason}) ${this.session.id}`);
    this.failPending('Sessiya yopildi');
    const h = this.handle;
    this.handle = null;
    try {
      h.end();
      h.close();
    } catch {
      /* allaqachon */
    }
    try {
      this.abort?.abort();
    } catch {
      /* */
    }
    await Promise.race([this.loopDone ?? Promise.resolve(), new Promise((r) => setTimeout(r, 3000))]);
    this.closing = false;
    this.running = false;
    this.setState('idle');
  }
}

function taskPatchStatus(m: Record<string, unknown>): string | null {
  const patch = (m.patch ?? {}) as { status?: string };
  if (patch.status === 'completed') return 'completed';
  if (patch.status === 'failed') return 'failed';
  if (patch.status === 'killed') return 'stopped';
  return null;
}

function summarizeStructured(v: unknown): unknown {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  // Katta natijalarni qisqartiramiz (faqat kerakli maydonlar).
  const keep: Record<string, unknown> = {};
  for (const k of ['type', 'filePath', 'file_path', 'oldString', 'newString', 'structuredPatch', 'content', 'stdout', 'stderr', 'interrupted', 'status', 'totalDurationMs', 'totalTokens', 'totalToolUseCount', 'url', 'code', 'numFiles', 'numLines', 'query', 'results', 'agentId']) {
    if (k in o) {
      const val = o[k];
      keep[k] = typeof val === 'string' && val.length > 20000 ? val.slice(0, 20000) + '…' : val;
    }
  }
  return Object.keys(keep).length ? keep : undefined;
}

export function describeApiError(code: string): string {
  switch (code) {
    case 'authentication_failed':
      return 'API kalit noto\'g\'ri yoki o\'rnatilmagan. Sozlamalarda kalitni tekshiring.';
    case 'billing_error':
      return 'Hisobda mablag\' yetarli emas yoki billing xatosi (console.anthropic.com).';
    case 'rate_limit':
      return 'So\'rovlar chegarasi (429). Biroz kutib qayta urinib ko\'ring.';
    case 'overloaded':
      return 'Anthropic serveri band (529). Qayta urinib ko\'ring.';
    case 'model_not_found':
      return 'Tanlangan model mavjud emas yoki hisobingizga ochilmagan.';
    case 'max_output_tokens':
      return 'Javob uzunligi chegarasiga yetdi.';
    case 'invalid_request':
      return 'API so\'rov noto\'g\'ri (invalid_request).';
    case 'account_on_hold':
      return 'Anthropic hisobi vaqtincha to\'xtatilgan.';
    default:
      return 'API xatosi: ' + code;
  }
}
