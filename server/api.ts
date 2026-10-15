// REST marshrutlari.
import fs from 'node:fs';
import path from 'node:path';
import type { Router, Ctx, HttpOptions } from './http.js';
import { checkLogin, loginUser, publicUser } from './http.js';
import { Service, ServiceError } from './service.js';
import { COOKIE_NAME, verifyPassword } from './auth.js';
import { listDir, mimeOf, safeResolve, statFile } from './files.js';
import type { AppInfo, PermissionMode, Schedule, ScheduleSpec, UserPublic } from '../shared/protocol.js';
import { computeNextRun } from './scheduler.js';
import { DISALLOWED_TOOLS } from './runner.js';

const loginFailures = new Map<string, { n: number; until: number }>();

function clientIp(c: Ctx): string {
  const fwd = c.req.headers['x-forwarded-for'];
  const ip = typeof fwd === 'string' ? fwd.split(',')[0].trim() : c.req.socket.remoteAddress ?? '?';
  return ip;
}

export const AGENT_TOOL_CHOICES = ['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'WebSearch', 'WebFetch', 'TodoWrite', 'NotebookEdit', 'Agent', 'Skill'];

export function registerApi(r: Router, service: Service, opts: HttpOptions): void {
  const cfg = service.config;

  r.add('GET', '/api/app', 'none', (c) => {
    const info: AppInfo & { user: UserPublic | null } = {
      name: cfg.appName,
      version: cfg.version,
      desktop: cfg.desktop,
      base_path: cfg.basePath,
      models: service.models,
      api_key_set: Boolean(cfg.apiKey),
      default_model: cfg.defaultModel,
      setup_required: !cfg.apiKey,
      user: c.user ? publicUser(c.user) : null,
    };
    return info;
  });

  // ---- kirish ----
  r.add('POST', '/api/login', 'none', async (c) => {
    const ip = clientIp(c);
    const f = loginFailures.get(ip);
    if (f && f.until > Date.now()) throw new ServiceError(429, 'too_many', 'Ko\'p urinish. 1 daqiqadan keyin qayta urinib ko\'ring.');
    const body = await c.json<{ login?: string; password?: string }>();
    try {
      const u = checkLogin(service, String(body.login ?? ''), String(body.password ?? ''));
      loginFailures.delete(ip);
      loginUser(c, u);
      return { user: publicUser(u) };
    } catch (e) {
      const cur = loginFailures.get(ip) ?? { n: 0, until: 0 };
      cur.n += 1;
      if (cur.n >= 5) {
        cur.until = Date.now() + 60_000;
        cur.n = 0;
      }
      loginFailures.set(ip, cur);
      throw e;
    }
  });

  r.add('POST', '/api/logout', 'none', (c) => {
    c.setCookie(COOKIE_NAME, '', 0);
    return { ok: true };
  });

  r.add('GET', '/api/me', 'user', (c) => ({ user: publicUser(c.user!) }));

  r.add('PATCH', '/api/me', 'user', async (c) => {
    const b = await c.json<Partial<UserPublic>>();
    const patch: Record<string, unknown> = {};
    if (typeof b.name === 'string') patch.name = b.name.trim().slice(0, 60) || c.user!.name;
    if (b.lang === 'uz' || b.lang === 'ru') patch.lang = b.lang;
    if (b.theme === 'light' || b.theme === 'dark' || b.theme === 'system') patch.theme = b.theme;
    if (typeof b.instructions === 'string') patch.instructions = b.instructions.slice(0, 8000);
    if (typeof b.default_model === 'string') patch.default_model = service.validModel(b.default_model);
    if (typeof b.default_mode === 'string') patch.default_mode = service.validMode(c.user!, b.default_mode as PermissionMode);
    return { user: service.updateUser(c.user!.id, patch) };
  });

  r.add('POST', '/api/me/password', 'user', async (c) => {
    const b = await c.json<{ old?: string; password?: string }>();
    if (!cfg.desktop && !verifyPassword(String(b.old ?? ''), c.user!.pass_hash)) throw new ServiceError(400, 'bad_old', 'Joriy parol noto\'g\'ri');
    service.setPassword(c.user!.id, String(b.password ?? ''));
    return { ok: true };
  });

  // ---- loyihalar ----
  r.add('GET', '/api/projects', 'user', (c) => ({ projects: service.projectsOf(c.user!) }));
  r.add('POST', '/api/projects', 'user', async (c) => {
    const b = await c.json<{ name?: string; path?: string }>();
    return { project: service.createProject(c.user!, { name: String(b.name ?? ''), path: b.path ? String(b.path) : undefined }) };
  });
  r.add('PATCH', '/api/projects/:id', 'user', async (c) => {
    const p = service.getProject(c.user!, c.params.id);
    const b = await c.json<{ name?: string; instructions_note?: string }>();
    const patch: Record<string, unknown> = { updated: Date.now() };
    if (typeof b.name === 'string' && b.name.trim()) patch.name = b.name.trim().slice(0, 80);
    if (typeof b.instructions_note === 'string') patch.instructions_note = b.instructions_note.slice(0, 4000);
    return { project: service.store.projects.update(p.id, patch) };
  });
  r.add('DELETE', '/api/projects/:id', 'user', (c) => {
    service.deleteProject(c.user!, c.params.id);
    return { ok: true };
  });
  r.add('GET', '/api/projects/:id/files', 'user', (c) => {
    const p = service.getProject(c.user!, c.params.id);
    const rel = c.url.searchParams.get('path') ?? '';
    try {
      return { entries: listDir(p.path, rel), path: rel };
    } catch (e) {
      throw new ServiceError(400, 'bad_path', String((e as Error).message));
    }
  });
  r.add('GET', '/api/projects/:id/file', 'user', (c) => {
    const p = service.getProject(c.user!, c.params.id);
    const rel = c.url.searchParams.get('path') ?? '';
    const st = statFile(p.path, rel);
    if (!st) throw new ServiceError(404, 'file_not_found', 'Fayl topilmadi');
    const abs = safeResolve(p.path, rel);
    const download = c.url.searchParams.get('dl') === '1';
    const mime = mimeOf(abs);
    const inlineOk = /^(image\/|application\/pdf|text\/plain|text\/markdown|text\/csv)/.test(mime);
    const dispo = download || !inlineOk ? 'attachment' : 'inline';
    c.res.writeHead(200, {
      'content-type': inlineOk ? mime : 'application/octet-stream',
      'content-length': st.size,
      'content-disposition': `${dispo}; filename*=UTF-8''${encodeURIComponent(st.name)}`,
      'cache-control': 'private, max-age=60',
    });
    fs.createReadStream(abs).pipe(c.res);
    return undefined;
  });
  r.add('GET', '/api/projects/:id/text', 'user', (c) => {
    const p = service.getProject(c.user!, c.params.id);
    const rel = c.url.searchParams.get('path') ?? '';
    const st = statFile(p.path, rel);
    if (!st) throw new ServiceError(404, 'file_not_found', 'Fayl topilmadi');
    if (st.size > 2 * 1024 * 1024) throw new ServiceError(413, 'too_large', 'Fayl juda katta');
    return { text: fs.readFileSync(safeResolve(p.path, rel), 'utf8'), file: st };
  });
  r.add('PUT', '/api/projects/:id/upload', 'user', async (c) => {
    const p = service.getProject(c.user!, c.params.id);
    const name = c.url.searchParams.get('name') ?? 'fayl';
    const data = await c.raw(cfg.maxUploadBytes);
    return { attachment: service.saveUpload(c.user!, p, name, data) };
  });
  r.add('DELETE', '/api/projects/:id/file', 'user', (c) => {
    const p = service.getProject(c.user!, c.params.id);
    const rel = c.url.searchParams.get('path') ?? '';
    const abs = safeResolve(p.path, rel);
    if (!rel || abs === path.resolve(p.path)) throw new ServiceError(400, 'bad_path');
    fs.rmSync(abs, { recursive: true, force: true });
    return { ok: true };
  });
  r.add('GET', '/api/projects/:id/instructions', 'user', (c) => {
    const p = service.getProject(c.user!, c.params.id);
    const f = path.join(p.path, 'CLAUDE.md');
    return { text: fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '' };
  });
  r.add('PUT', '/api/projects/:id/instructions', 'user', async (c) => {
    const p = service.getProject(c.user!, c.params.id);
    const b = await c.json<{ text?: string }>();
    const f = path.join(p.path, 'CLAUDE.md');
    const text = String(b.text ?? '');
    if (text.trim()) fs.writeFileSync(f, text);
    else if (fs.existsSync(f)) fs.unlinkSync(f);
    return { ok: true };
  });

  // ---- sessiyalar ----
  r.add('GET', '/api/sessions', 'user', (c) => ({ sessions: service.sessionsOf(c.user!, c.url.searchParams.get('project') ?? undefined) }));
  r.add('POST', '/api/sessions', 'user', async (c) => {
    const b = await c.json<{ project_id?: string; model?: string; mode?: PermissionMode; agent?: string | null }>();
    if (!cfg.apiKey) throw new ServiceError(400, 'no_api_key', 'API kalit o\'rnatilmagan');
    return { session: service.createSession(c.user!, b) };
  });
  r.add('GET', '/api/sessions/:id', 'user', (c) => {
    const s = service.getSession(c.user!, c.params.id);
    const runner = service.runnerFor(c.user!, s.id);
    return { session: runner.session, history: runner.history(), pending: runner.pendingEvents(), todos: runner.todos, state: runner.state };
  });
  r.add('PATCH', '/api/sessions/:id', 'user', async (c) => {
    const s = service.getSession(c.user!, c.params.id);
    const b = await c.json<{ title?: string; pinned?: boolean; archived?: boolean }>();
    const patch: Record<string, unknown> = {};
    if (typeof b.title === 'string') patch.title = b.title.trim().slice(0, 120);
    if (typeof b.pinned === 'boolean') patch.pinned = b.pinned;
    if (typeof b.archived === 'boolean') patch.archived = b.archived;
    const next = service.store.sessions.update(s.id, patch)!;
    const runner = service.runners.get(s.id);
    if (runner) runner.session = next;
    service.broadcast(s.id, { t: 'session', session: next });
    return { session: next };
  });
  r.add('DELETE', '/api/sessions/:id', 'user', async (c) => {
    const s = service.getSession(c.user!, c.params.id);
    await service.closeRunner(s.id, 'delete');
    service.store.sessions.update(s.id, { archived: true });
    return { ok: true };
  });
  r.add('POST', '/api/sessions/:id/close', 'user', async (c) => {
    const s = service.getSession(c.user!, c.params.id);
    await service.closeRunner(s.id, 'user');
    return { ok: true };
  });

  // ---- agentlar ----
  r.add('GET', '/api/agents', 'user', (c) => ({ agents: service.agentsVisible(c.user!), tools: AGENT_TOOL_CHOICES, builtin: ['general-purpose', 'Explore', 'Plan'] }));
  r.add('POST', '/api/agents', 'user', async (c) => ({ agent: service.saveAgent(c.user!, await c.json()) }));
  r.add('PATCH', '/api/agents/:id', 'user', async (c) => ({ agent: service.saveAgent(c.user!, await c.json(), c.params.id) }));
  r.add('DELETE', '/api/agents/:id', 'user', (c) => {
    service.deleteAgent(c.user!, c.params.id);
    return { ok: true };
  });

  // ---- rejali vazifalar ----
  r.add('GET', '/api/schedules', 'user', (c) => ({ schedules: service.schedulesOf(c.user!) }));
  r.add('POST', '/api/schedules', 'user', async (c) => ({ schedule: saveSchedule(service, c, await c.json()) }));
  r.add('PATCH', '/api/schedules/:id', 'user', async (c) => ({ schedule: saveSchedule(service, c, await c.json(), c.params.id) }));
  r.add('DELETE', '/api/schedules/:id', 'user', (c) => {
    const s = service.store.schedules.get(c.params.id);
    if (!s || s.user_id !== c.user!.id) throw new ServiceError(404, 'not_found');
    service.store.schedules.delete(s.id);
    return { ok: true };
  });
  r.add('POST', '/api/schedules/:id/run', 'user', async (c) => {
    const s = service.store.schedules.get(c.params.id);
    if (!s || s.user_id !== c.user!.id) throw new ServiceError(404, 'not_found');
    if (!service.scheduler) throw new ServiceError(500, 'no_scheduler');
    const sid = await service.scheduler.run(s);
    return { session_id: sid };
  });

  // ---- foydalanish ----
  r.add('GET', '/api/usage', 'user', (c) => {
    const days = Math.min(365, Math.max(1, parseInt(c.url.searchParams.get('days') ?? '30', 10) || 30));
    const since = Date.now() - days * 86400_000;
    const sum = service.usageSummary(c.user!, since);
    const users: Record<string, string> = {};
    for (const uid of Object.keys(sum.by_user)) users[uid] = service.store.users.get(uid)?.name ?? uid;
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const month = service.usageSummary(c.user!, monthStart.getTime());
    return { ...sum, users, days, month_total: month.total, month_by_user: month.by_user, limit: c.user!.monthly_limit_usd };
  });

  // ---- admin ----
  r.add('GET', '/api/admin/users', 'admin', () => ({ users: service.store.users.all().map(publicUser) }));
  r.add('POST', '/api/admin/users', 'admin', async (c) => {
    const b = await c.json<{ login?: string; name?: string; role?: 'admin' | 'member'; password?: string; monthly_limit_usd?: number | null }>();
    const u = service.createUser({
      login: String(b.login ?? ''),
      name: String(b.name ?? ''),
      role: b.role === 'admin' ? 'admin' : 'member',
      password: String(b.password ?? ''),
      must_change: true,
      monthly_limit_usd: typeof b.monthly_limit_usd === 'number' ? b.monthly_limit_usd : null,
    });
    return { user: publicUser(u) };
  });
  r.add('PATCH', '/api/admin/users/:id', 'admin', async (c) => {
    const b = await c.json<{ name?: string; role?: 'admin' | 'member'; active?: boolean; monthly_limit_usd?: number | null }>();
    const target = service.store.users.get(c.params.id);
    if (!target) throw new ServiceError(404, 'not_found');
    const patch: Record<string, unknown> = {};
    if (typeof b.name === 'string') patch.name = b.name.trim().slice(0, 60);
    if (b.role === 'admin' || b.role === 'member') {
      if (target.id === c.user!.id && b.role !== 'admin') throw new ServiceError(400, 'self_demote', 'O\'z rolingizni pasaytira olmaysiz');
      patch.role = b.role;
    }
    if (typeof b.active === 'boolean') {
      if (target.id === c.user!.id && !b.active) throw new ServiceError(400, 'self_disable', 'O\'zingizni o\'chira olmaysiz');
      patch.active = b.active;
    }
    if (b.monthly_limit_usd === null || typeof b.monthly_limit_usd === 'number') patch.monthly_limit_usd = b.monthly_limit_usd;
    return { user: service.updateUser(target.id, patch) };
  });
  r.add('POST', '/api/admin/users/:id/password', 'admin', async (c) => {
    const b = await c.json<{ password?: string }>();
    if (!service.store.users.get(c.params.id)) throw new ServiceError(404, 'not_found');
    service.setPassword(c.params.id, String(b.password ?? ''), c.params.id !== c.user!.id);
    return { ok: true };
  });
  r.add('DELETE', '/api/admin/users/:id', 'admin', (c) => {
    if (c.params.id === c.user!.id) throw new ServiceError(400, 'self_delete', 'O\'zingizni o\'chira olmaysiz');
    service.store.users.update(c.params.id, { active: false });
    return { ok: true };
  });
  r.add('GET', '/api/admin/settings', 'admin', () => ({
    api_key_set: Boolean(cfg.apiKey),
    api_key_hint: cfg.apiKey ? '…' + cfg.apiKey.slice(-4) : '',
    default_model: cfg.defaultModel,
    app_name: cfg.appName,
    hide_api_key: cfg.hideApiKey,
    data_dir: cfg.dataDir,
    disallowed_tools: DISALLOWED_TOOLS,
    version: cfg.version,
  }));
  r.add('PUT', '/api/admin/settings', 'admin', async (c) => {
    const b = await c.json<{ api_key?: string; default_model?: string; app_name?: string }>();
    if (typeof b.api_key === 'string' && b.api_key.trim()) service.setApiKey(b.api_key);
    if (typeof b.default_model === 'string') {
      cfg.defaultModel = service.validModel(b.default_model);
      const { writeStoredConfig } = await import('./config.js');
      writeStoredConfig(cfg.dataDir, { defaultModel: cfg.defaultModel });
    }
    if (typeof b.app_name === 'string' && b.app_name.trim()) {
      cfg.appName = b.app_name.trim().slice(0, 40);
      const { writeStoredConfig } = await import('./config.js');
      writeStoredConfig(cfg.dataDir, { appName: cfg.appName });
    }
    return { ok: true, api_key_set: Boolean(cfg.apiKey) };
  });

  // Desktop: birinchi sozlash (kalit) — faqat desktop rejimida, token bilan
  r.add('PUT', '/api/setup', 'user', async (c) => {
    if (!cfg.desktop && c.user!.role !== 'admin') throw new ServiceError(403, 'forbidden');
    const b = await c.json<{ api_key?: string }>();
    service.setApiKey(String(b.api_key ?? ''));
    return { ok: true, api_key_set: Boolean(cfg.apiKey) };
  });

  void opts;
}

function saveSchedule(service: Service, c: Ctx, b: Partial<Schedule>, id?: string): Schedule {
  const user = c.user!;
  const existing = id ? service.store.schedules.get(id) : undefined;
  if (id && (!existing || existing.user_id !== user.id)) throw new ServiceError(404, 'not_found');
  const project = service.getProject(user, String(b.project_id ?? existing?.project_id ?? service.defaultProject(user).id));
  const spec = parseSpec(b.spec ?? existing?.spec);
  const prompt = String(b.prompt ?? existing?.prompt ?? '').trim();
  if (!prompt) throw new ServiceError(400, 'bad_prompt', 'Topshiriq matni bo\'sh');
  const s: Schedule = {
    id: existing?.id ?? `sch${Date.now().toString(36)}`,
    user_id: user.id,
    project_id: project.id,
    title: String(b.title ?? existing?.title ?? '').trim().slice(0, 80) || prompt.slice(0, 40),
    prompt: prompt.slice(0, 8000),
    model: service.validModel(String(b.model ?? existing?.model ?? user.default_model)),
    mode: b.mode === 'default' ? 'auto' : service.validMode(user, (b.mode ?? existing?.mode ?? 'auto') as PermissionMode),
    spec,
    enabled: typeof b.enabled === 'boolean' ? b.enabled : (existing?.enabled ?? true),
    last_run: existing?.last_run ?? null,
    last_session_id: existing?.last_session_id ?? null,
    last_status: existing?.last_status ?? null,
    next_run: null,
    created: existing?.created ?? Date.now(),
    max_budget_usd: Math.min(50, Math.max(0.1, Number(b.max_budget_usd ?? existing?.max_budget_usd ?? 2))),
  };
  s.next_run = s.enabled ? computeNextRun(s.spec, Date.now(), service.config.timezone) : null;
  service.store.schedules.put(s);
  return s;
}

function parseSpec(v: unknown): ScheduleSpec {
  const o = (v ?? {}) as Record<string, unknown>;
  const time = typeof o.time === 'string' && /^\d{2}:\d{2}$/.test(o.time) ? o.time : '09:00';
  switch (o.kind) {
    case 'daily':
      return { kind: 'daily', time };
    case 'weekly': {
      const days = Array.isArray(o.days) ? o.days.map(Number).filter((d) => d >= 1 && d <= 7) : [1];
      return { kind: 'weekly', days: days.length ? days : [1], time };
    }
    case 'interval':
      return { kind: 'interval', minutes: Math.max(15, Math.min(7 * 1440, Number(o.minutes) || 60)) };
    case 'once':
      return { kind: 'once', at: Number(o.at) || Date.now() + 3600_000 };
    default:
      throw new ServiceError(400, 'bad_spec', 'Jadval turi noto\'g\'ri');
  }
}
