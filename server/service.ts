// Ilova xizmati: foydalanuvchilar, loyihalar, sessiyalar, agentlar, runner'lar — HTTP va WS shu yerga tayanadi.
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { writeStoredConfig } from './config.js';
import { Store, newId, publicUser, type UserRecord } from './store.js';
import { hashPassword, randomPassword } from './auth.js';
import type { Engine, AgentDefinition } from './engine.js';
import { SessionRunner, type RunnerContext } from './runner.js';
import type { KeyProxy } from './proxy.js';
import type { Scheduler } from './scheduler.js';
import type { AgentDef, Attachment, LiveEvent, ModelOption, PermissionMode, Project, Schedule, SessionInfo, UserPublic } from '../shared/protocol.js';
import { ensureDir, isImageName, mimeOf, safeName, uniqueName } from './files.js';

export const DEFAULT_MODELS: ModelOption[] = [
  { value: 'fable', label: 'Fable 5.1', description: 'Eng kuchli — murakkab ishlar uchun (qimmat)' },
  { value: 'opus', label: 'Opus 5.5', description: 'Kuchli va chuqur fikrlaydi' },
  { value: 'sonnet', label: 'Sonnet 5.5', description: 'Tez va muvozanatli (tavsiya)' },
  { value: 'haiku', label: 'Haiku 5.5', description: 'Eng tez va eng arzon' },
];

export class ServiceError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export class Service {
  store: Store;
  runners = new Map<string, SessionRunner>();
  listeners = new Map<string, Set<(ev: LiveEvent) => void>>();
  models: ModelOption[] = DEFAULT_MODELS;
  scheduler: Scheduler | null = null;
  log: (msg: string, ...rest: unknown[]) => void;

  constructor(
    public config: AppConfig,
    public engine: Engine,
    public proxy: KeyProxy | null,
    log?: (msg: string, ...rest: unknown[]) => void,
  ) {
    this.store = new Store(config.dataDir);
    this.log = log ?? ((m, ...r) => console.log(new Date().toISOString(), m, ...r));
    this.ensureAdmin();
  }

  // ---------- foydalanuvchilar ----------

  private ensureAdmin(): void {
    if (this.store.users.size > 0) return;
    const password = this.config.adminPassword || randomPassword(12);
    const admin = this.createUser({ login: this.config.adminLogin, name: this.config.desktop ? 'Men' : 'Administrator', role: 'admin', password, must_change: !this.config.adminPassword && !this.config.desktop });
    if (!this.config.adminPassword && !this.config.desktop) {
      const f = path.join(this.config.dataDir, 'ADMIN_PAROL.txt');
      fs.writeFileSync(f, `Login: ${admin.login}\nParol: ${password}\n(birinchi kirishdan keyin o'zgartiring)\n`, { mode: 0o600 });
      this.log(`[service] admin yaratildi: login=${admin.login}, parol ${f} faylida`);
    }
  }

  createUser(p: { login: string; name: string; role: 'admin' | 'member'; password: string; must_change?: boolean; monthly_limit_usd?: number | null }): UserRecord {
    const login = p.login.trim().toLowerCase();
    if (!/^[a-z0-9_.-]{2,32}$/.test(login)) throw new ServiceError(400, 'bad_login', 'Login: 2–32 ta lotin harf, raqam, _ . -');
    if (this.store.userByLogin(login)) throw new ServiceError(409, 'login_taken', 'Bu login band');
    if (p.password.length < 6) throw new ServiceError(400, 'weak_password', 'Parol kamida 6 belgi');
    const u: UserRecord = {
      id: newId('u'),
      login,
      name: p.name.trim() || login,
      role: p.role,
      lang: 'uz',
      theme: 'system',
      active: true,
      monthly_limit_usd: p.monthly_limit_usd ?? null,
      instructions: '',
      default_model: this.config.defaultModel,
      default_mode: this.config.defaultMode,
      created: Date.now(),
      pass_hash: hashPassword(p.password),
      must_change_password: Boolean(p.must_change),
    };
    this.store.users.put(u);
    this.userDirs(u);
    this.defaultProject(u);
    return u;
  }

  userDirs(u: UserRecord): { root: string; claude: string; projects: string; sessions: string } {
    const root = path.join(this.config.dataDir, 'users', u.id);
    const dirs = { root, claude: path.join(root, 'claude'), projects: path.join(root, 'projects'), sessions: path.join(root, 'sessions') };
    for (const d of Object.values(dirs)) ensureDir(d);
    return dirs;
  }

  defaultProject(u: UserRecord): Project {
    const existing = this.store.projects.find((p) => p.user_id === u.id && p.kind === 'workspace');
    if (existing.length) return existing[0];
    const dir = path.join(this.userDirs(u).projects, 'ish-papkasi');
    ensureDir(dir);
    const p: Project = { id: newId('p'), user_id: u.id, name: 'Ish papkasi', path: dir, kind: 'workspace', created: Date.now(), updated: Date.now() };
    this.store.projects.put(p);
    return p;
  }

  updateUser(id: string, patch: Partial<UserRecord>): UserPublic {
    const u = this.store.users.update(id, patch);
    if (!u) throw new ServiceError(404, 'not_found');
    return publicUser(u);
  }

  setPassword(id: string, password: string, mustChange = false): void {
    if (password.length < 6) throw new ServiceError(400, 'weak_password', 'Parol kamida 6 belgi');
    this.store.users.update(id, { pass_hash: hashPassword(password), must_change_password: mustChange });
  }

  // ---------- loyihalar ----------

  projectsOf(user: UserRecord): Project[] {
    return this.store.projects.find((p) => p.user_id === user.id).sort((a, b) => (a.kind === 'workspace' ? -1 : b.kind === 'workspace' ? 1 : b.updated - a.updated));
  }

  getProject(user: UserRecord, id: string): Project {
    const p = this.store.projects.get(id);
    if (!p || p.user_id !== user.id) throw new ServiceError(404, 'project_not_found', 'Loyiha topilmadi');
    return p;
  }

  createProject(user: UserRecord, p: { name: string; path?: string }): Project {
    const name = (p.name || '').trim().slice(0, 80);
    if (!name) throw new ServiceError(400, 'bad_name', 'Nom kiriting');
    let dir: string;
    let kind: Project['kind'] = 'workspace';
    if (p.path) {
      // Tashqi papka: faqat desktop yoki admin (serverda o'z papkalariga ulanish)
      if (!this.config.desktop && user.role !== 'admin') throw new ServiceError(403, 'forbidden', 'Tashqi papkaga faqat admin ulanadi');
      dir = path.resolve(p.path);
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new ServiceError(400, 'bad_path', 'Papka topilmadi: ' + dir);
      kind = 'folder';
    } else {
      const slug = name.toLowerCase().replace(/[^a-z0-9а-яёўқғҳ]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'loyiha';
      dir = path.join(this.userDirs(user).projects, uniqueName(this.userDirs(user).projects, slug));
      ensureDir(dir);
    }
    const proj: Project = { id: newId('p'), user_id: user.id, name, path: dir, kind, created: Date.now(), updated: Date.now() };
    this.store.projects.put(proj);
    return proj;
  }

  deleteProject(user: UserRecord, id: string): void {
    const p = this.getProject(user, id);
    if (p.kind === 'workspace' && this.store.projects.find((x) => x.user_id === user.id && x.kind === 'workspace').length === 1) {
      throw new ServiceError(400, 'last_workspace', 'Asosiy ish papkasini o\'chirib bo\'lmaydi');
    }
    for (const s of this.store.sessions.find((s) => s.project_id === id)) this.store.sessions.update(s.id, { archived: true });
    this.store.projects.delete(id);
  }

  saveUpload(user: UserRecord, project: Project, name: string, data: Buffer): Attachment {
    if (data.length > this.config.maxUploadBytes) throw new ServiceError(413, 'too_large', 'Fayl juda katta');
    const dir = path.join(project.path, 'uploads');
    ensureDir(dir);
    const safe = safeName(name);
    const final = uniqueName(dir, safe);
    fs.writeFileSync(path.join(dir, final), data);
    return { path: 'uploads/' + final, name: final, size: data.length, mime: mimeOf(final), image: isImageName(final) };
  }

  // ---------- sessiyalar ----------

  sessionsOf(user: UserRecord, projectId?: string): SessionInfo[] {
    return this.store.sessions
      .find((s) => s.user_id === user.id && !s.archived && (!projectId || s.project_id === projectId))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updated - a.updated);
  }

  getSession(user: UserRecord, id: string): SessionInfo {
    const s = this.store.sessions.get(id);
    if (!s || (s.user_id !== user.id && user.role !== 'admin')) throw new ServiceError(404, 'session_not_found', 'Suhbat topilmadi');
    return s;
  }

  createSession(user: UserRecord, p: { project_id?: string; model?: string; mode?: PermissionMode; agent?: string | null; title?: string; origin?: 'chat' | 'schedule' }): SessionInfo {
    const project = p.project_id ? this.getProject(user, p.project_id) : this.defaultProject(user);
    const model = this.validModel(p.model || user.default_model);
    const mode = this.validMode(user, p.mode || user.default_mode);
    const s: SessionInfo = {
      id: newId('s'),
      user_id: user.id,
      project_id: project.id,
      title: p.title ?? '',
      created: Date.now(),
      updated: Date.now(),
      model,
      mode,
      agent: p.agent || null,
      cost_usd: 0,
      turns: 0,
      pinned: false,
      archived: false,
      origin: p.origin ?? 'chat',
      state: 'idle',
      sdk_session_id: null,
      files: [],
      stats: { web_searches: 0, tool_uses: 0, uploads: 0, input_tokens: 0, output_tokens: 0, context_tokens: 0, context_window: 0 },
    };
    this.store.sessions.put(s);
    this.store.projects.update(project.id, { updated: Date.now() });
    return s;
  }

  validModel(m: string): string {
    if (this.models.some((x) => x.value === m)) return m;
    if (/^claude-[a-z0-9-]+$/.test(m)) return m;
    return this.config.defaultModel;
  }

  validMode(user: UserRecord, m: PermissionMode): PermissionMode {
    const ok: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'auto'];
    if (this.config.allowBypass && user.role === 'admin') ok.push('bypassPermissions');
    return ok.includes(m) ? m : 'auto';
  }

  runnerFor(user: UserRecord, sessionId: string): SessionRunner {
    const existing = this.runners.get(sessionId);
    if (existing) return existing;
    const session = this.getSession(user, sessionId);
    const owner = this.store.users.get(session.user_id)!;
    const project = this.store.projects.get(session.project_id);
    if (!project) throw new ServiceError(404, 'project_not_found', 'Loyiha o\'chirilgan');
    const ctx: RunnerContext = {
      engine: this.engine,
      store: this.store,
      config: this.config,
      emit: (sid, ev) => this.broadcast(sid, ev),
      envForUser: (u) => this.envForUser(u),
      agentsForUser: (u) => this.agentsForUser(u),
      systemPromptFor: (u, p) => this.systemPromptFor(u, p),
      log: this.log,
    };
    const r = new SessionRunner(ctx, session, project, owner);
    this.runners.set(sessionId, r);
    return r;
  }

  async closeRunner(sessionId: string, reason: string): Promise<void> {
    const r = this.runners.get(sessionId);
    if (!r) return;
    await r.close(reason);
    this.runners.delete(sessionId);
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.runners.keys()].map((id) => this.closeRunner(id, 'shutdown')));
    this.store.flushAll();
  }

  subscribe(sessionId: string, fn: (ev: LiveEvent) => void): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set!.delete(fn);
      if (set!.size === 0) this.listeners.delete(sessionId);
    };
  }

  broadcast(sessionId: string, ev: LiveEvent): void {
    const set = this.listeners.get(sessionId);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(ev);
      } catch (e) {
        this.log('[service] listener xatosi', e);
      }
    }
  }

  // ---------- agent muhiti ----------

  envForUser(user: UserRecord): Record<string, string | undefined> {
    const env: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/(SECRET|PASSWORD|_TOKEN|API_KEY|APIKEY|PAROL)/i.test(k)) continue;
      env[k] = v;
    }
    const dirs = this.userDirs(user);
    env.CLAUDE_CONFIG_DIR = dirs.claude;
    env.CLAUDE_AGENT_SDK_CLIENT_APP = `tta-claude/${this.config.version}`;
    env.TZ = this.config.timezone;
    env.DISABLE_AUTOUPDATER = '1';
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';
    if (this.proxy && this.config.hideApiKey) {
      env.ANTHROPIC_API_KEY = this.proxy.localKey;
      env.ANTHROPIC_BASE_URL = this.proxy.baseUrl;
    } else {
      env.ANTHROPIC_API_KEY = this.config.apiKey;
      if (this.config.apiBaseUrl && this.config.apiBaseUrl !== 'https://api.anthropic.com') env.ANTHROPIC_BASE_URL = this.config.apiBaseUrl;
    }
    return env;
  }

  agentsForUser(user: UserRecord): Record<string, AgentDefinition> {
    const out: Record<string, AgentDefinition> = {};
    for (const a of this.store.agents.find((a) => a.user_id === null || a.user_id === user.id)) {
      out[a.name] = {
        description: a.description || a.title,
        prompt: a.prompt,
        tools: a.tools.length ? a.tools : undefined,
        model: a.model || undefined,
      };
    }
    return out;
  }

  systemPromptFor(user: UserRecord, project: Project): string {
    const lang = user.lang === 'ru' ? 'Отвечай по-русски, если пользователь не попросил иначе.' : 'Foydalanuvchi bilan o\'zbek tilida (lotin yozuvida) muloqot qil, agar u boshqa tilda yozmasa.';
    const parts = [
      `Sen "${this.config.appName}" ilovasida ishlayotgan yordamchi agentsan. Foydalanuvchi: ${user.name}.`,
      `Ish papkasi: ${project.path} (loyiha: "${project.name}"). Yaratilgan fayllarni shu papkaga (yoki uning ichidagi mos papkaga) saqla; foydalanuvchi ularni "Natijalar" panelidan yuklab oladi.`,
      `Fayl yaratganda yo'lini qisqa aytib o't. Yuklangan fayllar ${path.join(project.path, 'uploads')} papkasida.`,
      lang,
    ];
    if (user.instructions.trim()) parts.push('Foydalanuvchi ko\'rsatmalari:\n' + user.instructions.trim());
    if (project.instructions_note?.trim()) parts.push('Loyiha haqida:\n' + project.instructions_note.trim());
    return parts.join('\n\n');
  }

  // ---------- agentlar ----------

  agentsVisible(user: UserRecord): AgentDef[] {
    return this.store.agents.find((a) => a.user_id === null || a.user_id === user.id).sort((a, b) => a.title.localeCompare(b.title));
  }

  saveAgent(user: UserRecord, data: Partial<AgentDef>, id?: string): AgentDef {
    const name = String(data.name ?? '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) throw new ServiceError(400, 'bad_agent_name', 'Agent nomi: lotin harf, raqam, - (masalan: hisobchi)');
    const title = String(data.title ?? '').trim() || name;
    const prompt = String(data.prompt ?? '').trim();
    if (!prompt) throw new ServiceError(400, 'bad_prompt', 'Agent ko\'rsatmasi (prompt) bo\'sh');
    const shared = user.role === 'admin' && data.user_id === null;
    const existing = id ? this.store.agents.get(id) : undefined;
    if (id && (!existing || (existing.user_id !== user.id && !(user.role === 'admin' && existing.user_id === null)))) throw new ServiceError(404, 'not_found');
    const dup = this.store.agents.find((a) => a.name === name && a.id !== id && (a.user_id === null || a.user_id === user.id));
    if (dup.length) throw new ServiceError(409, 'agent_exists', 'Bu nomli agent bor');
    const a: AgentDef = {
      id: existing?.id ?? newId('a'),
      user_id: shared ? null : (existing?.user_id ?? user.id),
      name,
      title,
      description: String(data.description ?? '').trim().slice(0, 300),
      prompt,
      tools: Array.isArray(data.tools) ? data.tools.map(String).filter(Boolean) : [],
      model: String(data.model ?? ''),
      color: String(data.color ?? '#4f46e5'),
      created: existing?.created ?? Date.now(),
      updated: Date.now(),
    };
    this.store.agents.put(a);
    return a;
  }

  deleteAgent(user: UserRecord, id: string): void {
    const a = this.store.agents.get(id);
    if (!a) return;
    if (a.user_id !== user.id && !(user.role === 'admin' && a.user_id === null)) throw new ServiceError(403, 'forbidden');
    this.store.agents.delete(id);
  }

  // ---------- rejali vazifalar ----------

  schedulesOf(user: UserRecord): Schedule[] {
    return this.store.schedules.find((s) => s.user_id === user.id).sort((a, b) => b.created - a.created);
  }

  // ---------- sozlamalar ----------

  setApiKey(key: string): void {
    const k = key.trim();
    if (k && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw new ServiceError(400, 'bad_key', 'Kalit "sk-ant-" bilan boshlanishi kerak');
    this.config.apiKey = k;
    writeStoredConfig(this.config.dataDir, { apiKey: k });
    this.proxy?.setRealKey(k);
  }

  usageSummary(user: UserRecord, since: number): { by_user: Record<string, { cost: number; input: number; output: number; sessions: number }>; by_day: Record<string, number>; total: number } {
    const recs = this.store.readUsage(since).filter((r) => user.role === 'admin' || r.user_id === user.id);
    const by_user: Record<string, { cost: number; input: number; output: number; sessions: number }> = {};
    const by_day: Record<string, number> = {};
    const sess: Record<string, Set<string>> = {};
    let total = 0;
    for (const r of recs) {
      const u = (by_user[r.user_id] ??= { cost: 0, input: 0, output: 0, sessions: 0 });
      u.cost += r.cost_usd;
      u.input += r.input_tokens;
      u.output += r.output_tokens;
      (sess[r.user_id] ??= new Set()).add(r.session_id);
      const day = new Date(r.ts).toISOString().slice(0, 10);
      by_day[day] = (by_day[day] ?? 0) + r.cost_usd;
      total += r.cost_usd;
    }
    for (const [uid, set] of Object.entries(sess)) by_user[uid].sessions = set.size;
    return { by_user, by_day, total };
  }
}
