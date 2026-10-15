// Sahifalar: agentlar, rejali vazifalar, sozlamalar, boshqaruv, kirish, birinchi sozlash.
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { AgentDef, PermissionMode, Schedule, ScheduleSpec, UserPublic } from '../../shared/protocol';
import { api } from './api';
import { MODES } from './chat';
import { Icon, Logo } from './icons';
import { t, lang, setLang } from './i18n';
import { agents, app, isAdmin, loadApp, loadUserData, navigate, projects, sidebarOpen, toast, user, theme, applyTheme } from './state';
import { Empty, Field, Modal, fmtDate, fmtMoney, fmtTokens } from './ui';

function TopBar({ title, right }: { title: string; right?: JSX.Element | null }): JSX.Element {
  return (
    <div class="topbar">
      <button class="icon-btn show-mobile" onClick={() => (sidebarOpen.value = true)} aria-label="menu">
        <Icon name="menu" />
      </button>
      <div class="topbar-title">{title}</div>
      <span class="grow" />
      {right}
    </div>
  );
}

// ---------- agentlar ----------

const COLORS = ['#4f46e5', '#0891b2', '#059669', '#d97706', '#dc2626', '#7c3aed', '#db2777', '#475569'];

export function AgentsPage(): JSX.Element {
  const [edit, setEdit] = useState<Partial<AgentDef> | null>(null);
  const [tools, setTools] = useState<string[]>([]);
  const [builtin, setBuiltin] = useState<string[]>([]);
  const reload = async (): Promise<void> => {
    const r = await api.get<{ agents: AgentDef[]; tools: string[]; builtin: string[] }>('/api/agents');
    agents.value = r.agents;
    setTools(r.tools);
    setBuiltin(r.builtin);
  };
  useEffect(() => void reload(), []);
  const save = async (): Promise<void> => {
    if (!edit) return;
    try {
      if (edit.id) await api.patch(`/api/agents/${edit.id}`, edit);
      else await api.post('/api/agents', edit);
      setEdit(null);
      await reload();
      toast(t('saved'), 'ok');
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  };
  const del = async (a: AgentDef): Promise<void> => {
    if (!confirm(t('confirm_delete'))) return;
    await api.del(`/api/agents/${a.id}`);
    await reload();
  };
  const startWith = (a: AgentDef): void => {
    localStorage.setItem('tta.agent', a.name);
    navigate('/');
  };
  return (
    <div class="page">
      <TopBar
        title={t('agents')}
        right={
          <button class="btn primary small" onClick={() => setEdit({ name: '', title: '', description: '', prompt: '', tools: [], model: '', color: COLORS[agents.value.length % COLORS.length], user_id: user.value!.id })}>
            <Icon name="plus" size={14} /> {t('new_agent')}
          </button>
        }
      />
      <div class="page-body">
        <p class="muted">{t('agents_help')}</p>
        <h3>{t('agents_title')}</h3>
        {agents.value.length === 0 && <Empty icon="bot" text={t('new_agent')} />}
        <div class="cards">
          {agents.value.map((a) => (
            <div key={a.id} class="card static">
              <div class="card-head">
                <span class="agent-dot" style={{ background: a.color }} />
                <strong>{a.title}</strong>
                <span class="muted small mono">{a.name}</span>
                {a.user_id === null && <span class="tag">{t('agent_shared')}</span>}
              </div>
              <div class="small">{a.description}</div>
              <div class="muted small">
                {a.tools.length ? a.tools.join(', ') : t('tools') + ': *'} {a.model ? '· ' + a.model : ''}
              </div>
              <div class="row">
                <button class="btn small primary" onClick={() => startWith(a)}>
                  <Icon name="send" size={13} /> {t('start_with_agent')}
                </button>
                {(a.user_id === user.value!.id || (isAdmin.value && a.user_id === null)) && (
                  <>
                    <button class="btn small" onClick={() => setEdit({ ...a })}>
                      {t('edit')}
                    </button>
                    <button class="btn small danger" onClick={() => void del(a)}>
                      <Icon name="trash" size={13} />
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
        <h3>{t('builtin_agents')}</h3>
        <div class="muted small">{builtin.join(' · ')}</div>
      </div>
      {edit && (
        <Modal title={edit.id ? t('edit') : t('new_agent')} onClose={() => setEdit(null)} wide>
          <div class="grid2">
            <Field label={t('agent_name')}>
              <input class="input" value={edit.name ?? ''} onInput={(e) => setEdit({ ...edit, name: (e.target as HTMLInputElement).value })} placeholder="hisobchi" />
            </Field>
            <Field label={t('agent_title')}>
              <input class="input" value={edit.title ?? ''} onInput={(e) => setEdit({ ...edit, title: (e.target as HTMLInputElement).value })} />
            </Field>
          </div>
          <Field label={t('agent_desc')}>
            <input class="input" value={edit.description ?? ''} onInput={(e) => setEdit({ ...edit, description: (e.target as HTMLInputElement).value })} />
          </Field>
          <Field label={t('agent_prompt')}>
            <textarea class="input" rows={8} value={edit.prompt ?? ''} onInput={(e) => setEdit({ ...edit, prompt: (e.target as HTMLTextAreaElement).value })} />
          </Field>
          <Field label={t('agent_tools')}>
            <div class="chips">
              {tools.map((tool) => (
                <button key={tool} class={`chip ${edit.tools?.includes(tool) ? 'on' : ''}`} onClick={() => setEdit({ ...edit, tools: edit.tools?.includes(tool) ? edit.tools.filter((x) => x !== tool) : [...(edit.tools ?? []), tool] })}>
                  {tool}
                </button>
              ))}
            </div>
          </Field>
          <div class="grid2">
            <Field label={t('agent_model')}>
              <select class="select" value={edit.model ?? ''} onChange={(e) => setEdit({ ...edit, model: (e.target as HTMLSelectElement).value })}>
                <option value="">—</option>
                {app.value?.models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label=" ">
              <div class="row">
                {COLORS.map((c) => (
                  <button key={c} class={`color ${edit.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => setEdit({ ...edit, color: c })} />
                ))}
              </div>
            </Field>
          </div>
          {isAdmin.value && (
            <label class="check">
              <input type="checkbox" checked={edit.user_id === null} onChange={(e) => setEdit({ ...edit, user_id: (e.target as HTMLInputElement).checked ? null : user.value!.id })} /> {t('agent_shared')}
            </label>
          )}
          <div class="row end">
            <button class="btn" onClick={() => setEdit(null)}>
              {t('cancel')}
            </button>
            <button class="btn primary" onClick={() => void save()}>
              {t('save')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---------- rejali vazifalar ----------

const DAYS_UZ = ['Du', 'Se', 'Ch', 'Pa', 'Ju', 'Sh', 'Ya'];
const DAYS_RU = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];

export function SchedulesPage(): JSX.Element {
  const [list, setList] = useState<Schedule[]>([]);
  const [edit, setEdit] = useState<Partial<Schedule> | null>(null);
  const reload = async (): Promise<void> => setList((await api.get<{ schedules: Schedule[] }>('/api/schedules')).schedules);
  useEffect(() => void reload(), []);
  const save = async (): Promise<void> => {
    if (!edit) return;
    try {
      if (edit.id) await api.patch(`/api/schedules/${edit.id}`, edit);
      else await api.post('/api/schedules', edit);
      setEdit(null);
      await reload();
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  };
  const spec: ScheduleSpec = (edit?.spec as ScheduleSpec) ?? { kind: 'daily', time: '09:00' };
  const setSpec = (s: ScheduleSpec): void => setEdit({ ...edit, spec: s });
  const days = lang.value === 'ru' ? DAYS_RU : DAYS_UZ;
  return (
    <div class="page">
      <TopBar
        title={t('schedules')}
        right={
          <button class="btn primary small" onClick={() => setEdit({ title: '', prompt: '', project_id: projects.value[0]?.id, model: user.value!.default_model, mode: 'acceptEdits', spec: { kind: 'daily', time: '09:00' }, enabled: true, max_budget_usd: 2 })}>
            <Icon name="plus" size={14} /> {t('new_schedule')}
          </button>
        }
      />
      <div class="page-body">
        <p class="muted">{t('schedules_help')}</p>
        {list.length === 0 && <Empty icon="clock" text={t('new_schedule')} />}
        <div class="cards">
          {list.map((s) => (
            <div key={s.id} class="card static">
              <div class="card-head">
                <Icon name="clock" size={16} />
                <strong>{s.title}</strong>
                <span class={`tag ${s.enabled ? 'ok' : ''}`}>{s.enabled ? t('enabled') : t('inactive')}</span>
              </div>
              <div class="small clamp">{s.prompt}</div>
              <div class="muted small">
                {describeSpec(s.spec, days)} · {t('next_run')}: {s.next_run ? fmtDate(s.next_run) : '—'} · {t('last_run')}: {s.last_run ? fmtDate(s.last_run) + (s.last_status === 'error' ? ' ⚠' : ' ✓') : t('never')}
              </div>
              <div class="row">
                {s.last_session_id && (
                  <button class="btn small" onClick={() => navigate('/s/' + s.last_session_id)}>
                    <Icon name="history" size={13} /> {t('last_run')}
                  </button>
                )}
                <button class="btn small" onClick={() => void api.post(`/api/schedules/${s.id}/run`).then(() => (toast(t('running')), reload()))}>
                  <Icon name="play" size={13} /> {t('run_now')}
                </button>
                <button class="btn small" onClick={() => setEdit({ ...s })}>
                  {t('edit')}
                </button>
                <button class="btn small danger" onClick={() => confirm(t('confirm_delete')) && void api.del(`/api/schedules/${s.id}`).then(reload)}>
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
      {edit && (
        <Modal title={edit.id ? t('edit') : t('new_schedule')} onClose={() => setEdit(null)} wide>
          <Field label={t('schedule_title')}>
            <input class="input" value={edit.title ?? ''} onInput={(e) => setEdit({ ...edit, title: (e.target as HTMLInputElement).value })} />
          </Field>
          <Field label={t('schedule_prompt')}>
            <textarea class="input" rows={5} value={edit.prompt ?? ''} onInput={(e) => setEdit({ ...edit, prompt: (e.target as HTMLTextAreaElement).value })} />
          </Field>
          <div class="grid2">
            <Field label={t('project')}>
              <select class="select" value={edit.project_id ?? ''} onChange={(e) => setEdit({ ...edit, project_id: (e.target as HTMLSelectElement).value })}>
                {projects.value.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t('model')}>
              <select class="select" value={edit.model ?? ''} onChange={(e) => setEdit({ ...edit, model: (e.target as HTMLSelectElement).value })}>
                {app.value?.models.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div class="grid2">
            <Field label={t('schedule_kind')}>
              <select class="select" value={spec.kind} onChange={(e) => {
                const k = (e.target as HTMLSelectElement).value as ScheduleSpec['kind'];
                setSpec(k === 'daily' ? { kind: 'daily', time: '09:00' } : k === 'weekly' ? { kind: 'weekly', days: [1], time: '09:00' } : k === 'interval' ? { kind: 'interval', minutes: 60 } : { kind: 'once', at: Date.now() + 3600_000 });
              }}>
                <option value="daily">{t('kind_daily')}</option>
                <option value="weekly">{t('kind_weekly')}</option>
                <option value="interval">{t('kind_interval')}</option>
                <option value="once">{t('kind_once')}</option>
              </select>
            </Field>
            {(spec.kind === 'daily' || spec.kind === 'weekly') && (
              <Field label={t('time')}>
                <input class="input" type="time" value={spec.time} onInput={(e) => setSpec({ ...spec, time: (e.target as HTMLInputElement).value })} />
              </Field>
            )}
            {spec.kind === 'interval' && (
              <Field label={t('minutes')}>
                <input class="input" type="number" min={15} value={spec.minutes} onInput={(e) => setSpec({ kind: 'interval', minutes: Number((e.target as HTMLInputElement).value) })} />
              </Field>
            )}
            {spec.kind === 'once' && (
              <Field label={t('time')}>
                <input class="input" type="datetime-local" value={toLocalInput(spec.at)} onInput={(e) => setSpec({ kind: 'once', at: new Date((e.target as HTMLInputElement).value).getTime() })} />
              </Field>
            )}
          </div>
          {spec.kind === 'weekly' && (
            <Field label={t('days')}>
              <div class="chips">
                {days.map((d, i) => (
                  <button key={d} class={`chip ${spec.days.includes(i + 1) ? 'on' : ''}`} onClick={() => setSpec({ ...spec, days: spec.days.includes(i + 1) ? spec.days.filter((x) => x !== i + 1) : [...spec.days, i + 1].sort() })}>
                    {d}
                  </button>
                ))}
              </div>
            </Field>
          )}
          <div class="grid2">
            <Field label={t('budget')}>
              <input class="input" type="number" step="0.5" min={0.1} value={edit.max_budget_usd ?? 2} onInput={(e) => setEdit({ ...edit, max_budget_usd: Number((e.target as HTMLInputElement).value) })} />
            </Field>
            <Field label={t('mode')}>
              <select class="select" value={edit.mode ?? 'acceptEdits'} onChange={(e) => setEdit({ ...edit, mode: (e.target as HTMLSelectElement).value as PermissionMode })}>
                {['acceptEdits', 'auto', 'plan'].map((m) => (
                  <option key={m} value={m}>
                    {t(`mode_${m}` as never)}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <label class="check">
            <input type="checkbox" checked={edit.enabled !== false} onChange={(e) => setEdit({ ...edit, enabled: (e.target as HTMLInputElement).checked })} /> {t('enabled')}
          </label>
          <div class="row end">
            <button class="btn" onClick={() => setEdit(null)}>
              {t('cancel')}
            </button>
            <button class="btn primary" onClick={() => void save()}>
              {t('save')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function describeSpec(s: ScheduleSpec, days: string[]): string {
  switch (s.kind) {
    case 'daily':
      return `${t('kind_daily')} ${s.time}`;
    case 'weekly':
      return `${s.days.map((d) => days[d - 1]).join(', ')} ${s.time}`;
    case 'interval':
      return `${t('kind_interval').replace('N', String(s.minutes))}`;
    case 'once':
      return `${t('kind_once')}: ${fmtDate(s.at)}`;
  }
}

function toLocalInput(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ---------- sozlamalar (shaxsiylashtirish) ----------

export function SettingsPage(): JSX.Element {
  const u = user.value!;
  const [form, setForm] = useState({ name: u.name, instructions: u.instructions, default_model: u.default_model, default_mode: u.default_mode });
  const [pw, setPw] = useState({ old: '', password: '' });
  const [apiKey, setApiKey] = useState('');
  const save = async (): Promise<void> => {
    try {
      const r = await api.patch<{ user: UserPublic }>('/api/me', form);
      user.value = r.user;
      toast(t('saved'), 'ok');
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  };
  const changePw = async (): Promise<void> => {
    try {
      await api.post('/api/me/password', pw);
      setPw({ old: '', password: '' });
      user.value = { ...u, must_change_password: false };
      toast(t('saved'), 'ok');
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  };
  const saveKey = async (): Promise<void> => {
    try {
      await api.put('/api/setup', { api_key: apiKey });
      setApiKey('');
      await loadApp();
      toast(t('saved'), 'ok');
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  };
  const modes = MODES.filter((m) => m !== 'bypassPermissions' || isAdmin.value);
  return (
    <div class="page">
      <TopBar title={t('personalization')} />
      <div class="page-body form narrow">
        {u.must_change_password && (
          <div class="sys warning">
            <Icon name="warn" size={14} /> {t('must_change')}
          </div>
        )}
        <Field label={t('name')}>
          <input class="input" value={form.name} onInput={(e) => setForm({ ...form, name: (e.target as HTMLInputElement).value })} />
        </Field>
        <Field label={t('instructions')} help={t('instructions_help')}>
          <textarea class="input" rows={8} value={form.instructions} onInput={(e) => setForm({ ...form, instructions: (e.target as HTMLTextAreaElement).value })} />
        </Field>
        <div class="grid2">
          <Field label={t('default_model')}>
            <select class="select" value={form.default_model} onChange={(e) => setForm({ ...form, default_model: (e.target as HTMLSelectElement).value })}>
              {app.value?.models.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label} — {m.description}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('default_mode')}>
            <select class="select" value={form.default_mode} onChange={(e) => setForm({ ...form, default_mode: (e.target as HTMLSelectElement).value as PermissionMode })}>
              {modes.map((m) => (
                <option key={m} value={m}>
                  {t(`mode_${m}` as never)} — {t(`mode_${m}_desc` as never)}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div class="grid2">
          <Field label={t('theme')}>
            <select class="select" value={theme.value} onChange={(e) => ((theme.value = (e.target as HTMLSelectElement).value as 'light' | 'dark' | 'system'), applyTheme(), void api.patch('/api/me', { theme: theme.value }))}>
              <option value="system">{t('theme_system')}</option>
              <option value="light">{t('theme_light')}</option>
              <option value="dark">{t('theme_dark')}</option>
            </select>
          </Field>
          <Field label="Til / Язык">
            <select class="select" value={lang.value} onChange={(e) => (setLang((e.target as HTMLSelectElement).value as 'uz' | 'ru'), void api.patch('/api/me', { lang: (e.target as HTMLSelectElement).value }))}>
              <option value="uz">{t('lang_uz')}</option>
              <option value="ru">{t('lang_ru')}</option>
            </select>
          </Field>
        </div>
        <div class="row end">
          <button class="btn primary" onClick={() => void save()}>
            {t('save')}
          </button>
        </div>
        {!app.value?.desktop && (
          <>
            <h3>{t('change_password')}</h3>
            <div class="grid2">
              <Field label={t('old_password')}>
                <input class="input" type="password" value={pw.old} onInput={(e) => setPw({ ...pw, old: (e.target as HTMLInputElement).value })} />
              </Field>
              <Field label={t('new_password')}>
                <input class="input" type="password" value={pw.password} onInput={(e) => setPw({ ...pw, password: (e.target as HTMLInputElement).value })} />
              </Field>
            </div>
            <div class="row end">
              <button class="btn" disabled={pw.password.length < 6} onClick={() => void changePw()}>
                {t('change_password')}
              </button>
            </div>
          </>
        )}
        {(app.value?.desktop || isAdmin.value) && (
          <>
            <h3>{t('api_key')}</h3>
            <div class="muted small">
              {app.value?.api_key_set ? '✓ ' + t('api_key_set') : '⚠ ' + t('api_key_missing')} · {t('api_key_help')}
            </div>
            <div class="row">
              <input class="input grow" type="password" placeholder="sk-ant-…" value={apiKey} onInput={(e) => setApiKey((e.target as HTMLInputElement).value)} autocomplete="off" />
              <button class="btn primary" disabled={!apiKey.trim()} onClick={() => void saveKey()}>
                {t('save')}
              </button>
            </div>
          </>
        )}
        <div class="muted small">
          {t('version')}: {app.value?.version}
          {window.desktop ? ` · desktop ${window.desktop.version}` : ''}
        </div>
      </div>
    </div>
  );
}

// ---------- boshqaruv ----------

interface UsageInfo {
  by_user: Record<string, { cost: number; input: number; output: number; sessions: number }>;
  by_day: Record<string, number>;
  total: number;
  users: Record<string, string>;
  month_total: number;
  month_by_user: Record<string, { cost: number }>;
}

export function AdminPage(): JSX.Element {
  const [users, setUsers] = useState<UserPublic[]>([]);
  const [usage, setUsage] = useState<UsageInfo | null>(null);
  const [settings, setSettings] = useState<{ api_key_set: boolean; api_key_hint: string; default_model: string; app_name: string; data_dir: string; version: string } | null>(null);
  const [nu, setNu] = useState({ login: '', name: '', password: '', role: 'member' as 'member' | 'admin', monthly_limit_usd: '' });
  const [apiKey, setApiKey] = useState('');
  const reload = async (): Promise<void> => {
    const [u, g, s] = await Promise.all([api.get<{ users: UserPublic[] }>('/api/admin/users'), api.get<UsageInfo>('/api/usage?days=30'), api.get<typeof settings>('/api/admin/settings')]);
    setUsers(u.users);
    setUsage(g);
    setSettings(s);
  };
  useEffect(() => void reload(), []);
  const addUser = async (): Promise<void> => {
    try {
      await api.post('/api/admin/users', { ...nu, monthly_limit_usd: nu.monthly_limit_usd ? Number(nu.monthly_limit_usd) : null });
      setNu({ login: '', name: '', password: '', role: 'member', monthly_limit_usd: '' });
      await reload();
      toast(t('saved'), 'ok');
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  };
  const patchUser = async (id: string, patch: Record<string, unknown>): Promise<void> => {
    try {
      await api.patch(`/api/admin/users/${id}`, patch);
      await reload();
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  };
  const resetPw = async (id: string): Promise<void> => {
    const p = prompt(t('new_password'));
    if (!p) return;
    try {
      await api.post(`/api/admin/users/${id}/password`, { password: p });
      toast(t('temp_password_note'), 'ok');
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  };
  const saveSettings = async (): Promise<void> => {
    try {
      await api.put('/api/admin/settings', { api_key: apiKey || undefined, default_model: settings?.default_model, app_name: settings?.app_name });
      setApiKey('');
      await reload();
      await loadApp();
      toast(t('saved'), 'ok');
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  };
  const days = usage ? Object.entries(usage.by_day).sort().slice(-30) : [];
  const maxDay = Math.max(0.01, ...days.map(([, v]) => v));
  return (
    <div class="page">
      <TopBar title={t('admin')} />
      <div class="page-body">
        <h3>{t('usage')}</h3>
        {usage && (
          <div class="usage-cards">
            <div class="stat">
              <div class="muted small">{t('usage_month')}</div>
              <div class="stat-val">{fmtMoney(usage.month_total)}</div>
            </div>
            <div class="stat">
              <div class="muted small">{t('usage_30')}</div>
              <div class="stat-val">{fmtMoney(usage.total)}</div>
            </div>
            <div class="stat chart">
              <div class="bars">
                {days.map(([d, v]) => (
                  <div key={d} class="bar-col" title={`${d}: ${fmtMoney(v)}`} style={{ height: Math.max(2, (v / maxDay) * 100) + '%' }} />
                ))}
              </div>
            </div>
          </div>
        )}
        <h3>{t('users')}</h3>
        <table class="table">
          <thead>
            <tr>
              <th>{t('login_label')}</th>
              <th>{t('name')}</th>
              <th>{t('role')}</th>
              <th>{t('usage_month')}</th>
              <th>{t('monthly_limit')}</th>
              <th>{t('active')}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} class={u.active ? '' : 'muted'}>
                <td class="mono">{u.login}</td>
                <td>{u.name}</td>
                <td>
                  <select class="select small" value={u.role} onChange={(e) => void patchUser(u.id, { role: (e.target as HTMLSelectElement).value })}>
                    <option value="member">{t('role_member')}</option>
                    <option value="admin">{t('role_admin')}</option>
                  </select>
                </td>
                <td>
                  {fmtMoney(usage?.month_by_user[u.id]?.cost ?? 0)} <span class="muted small">({fmtTokens(usage?.by_user[u.id]?.input ?? 0)} / {fmtTokens(usage?.by_user[u.id]?.output ?? 0)})</span>
                </td>
                <td>
                  <input class="input small" type="number" placeholder={t('no_limit')} value={u.monthly_limit_usd ?? ''} onChange={(e) => void patchUser(u.id, { monthly_limit_usd: (e.target as HTMLInputElement).value ? Number((e.target as HTMLInputElement).value) : null })} />
                </td>
                <td>
                  <input type="checkbox" checked={u.active} onChange={(e) => void patchUser(u.id, { active: (e.target as HTMLInputElement).checked })} />
                </td>
                <td>
                  <button class="btn small" onClick={() => void resetPw(u.id)}>
                    <Icon name="key" size={13} /> {t('reset_password')}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <h4>{t('add_user')}</h4>
        <div class="row wrap">
          <input class="input" placeholder={t('login_label')} value={nu.login} onInput={(e) => setNu({ ...nu, login: (e.target as HTMLInputElement).value })} />
          <input class="input" placeholder={t('name')} value={nu.name} onInput={(e) => setNu({ ...nu, name: (e.target as HTMLInputElement).value })} />
          <input class="input" placeholder={t('password')} value={nu.password} onInput={(e) => setNu({ ...nu, password: (e.target as HTMLInputElement).value })} />
          <select class="select" value={nu.role} onChange={(e) => setNu({ ...nu, role: (e.target as HTMLSelectElement).value as 'member' | 'admin' })}>
            <option value="member">{t('role_member')}</option>
            <option value="admin">{t('role_admin')}</option>
          </select>
          <input class="input" type="number" placeholder={t('monthly_limit')} value={nu.monthly_limit_usd} onInput={(e) => setNu({ ...nu, monthly_limit_usd: (e.target as HTMLInputElement).value })} />
          <button class="btn primary" disabled={!nu.login || nu.password.length < 6} onClick={() => void addUser()}>
            <Icon name="plus" size={14} /> {t('add_user')}
          </button>
        </div>
        <div class="muted small">{t('temp_password_note')}</div>
        {settings && (
          <>
            <h3>{t('settings')}</h3>
            <div class="form narrow">
              <Field label={t('api_key')} help={(settings.api_key_set ? '✓ ' + t('api_key_set') + ' ' + settings.api_key_hint : '⚠ ' + t('api_key_missing')) + ' · ' + t('api_key_help')}>
                <input class="input" type="password" placeholder="sk-ant-…" value={apiKey} onInput={(e) => setApiKey((e.target as HTMLInputElement).value)} autocomplete="off" />
              </Field>
              <div class="grid2">
                <Field label={t('default_model')}>
                  <select class="select" value={settings.default_model} onChange={(e) => setSettings({ ...settings, default_model: (e.target as HTMLSelectElement).value })}>
                    {app.value?.models.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t('app_name')}>
                  <input class="input" value={settings.app_name} onInput={(e) => setSettings({ ...settings, app_name: (e.target as HTMLInputElement).value })} />
                </Field>
              </div>
              <div class="row end">
                <button class="btn primary" onClick={() => void saveSettings()}>
                  {t('save')}
                </button>
              </div>
              <div class="muted small mono">
                {t('version')} {settings.version} · {settings.data_dir}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------- kirish ----------

export function LoginPage(): JSX.Element {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: Event): Promise<void> => {
    e.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await api.post('/api/login', { login, password });
      await loadApp();
      await loadUserData();
      navigate('/');
    } catch (ex) {
      setErr((ex as Error).message || t('login_error'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="login-wrap">
      <form class="login-card" onSubmit={(e) => void submit(e)}>
        <div class="brand center">
          <Logo size={44} />
          <div class="brand-name big">{app.value?.name ?? 'TTA CLAUDE'}</div>
          <div class="muted small">{t('app_tagline')} · {t('powered')}</div>
        </div>
        <Field label={t('login_label')}>
          <input class="input" value={login} onInput={(e) => setLogin((e.target as HTMLInputElement).value)} autoFocus autocomplete="username" />
        </Field>
        <Field label={t('password')}>
          <input class="input" type="password" value={password} onInput={(e) => setPassword((e.target as HTMLInputElement).value)} autocomplete="current-password" />
        </Field>
        {err && <div class="sys error">{err}</div>}
        <button class="btn primary wide" disabled={busy || !login || !password}>
          {t('login_btn')}
        </button>
        <div class="row center">
          <button type="button" class="lang-btn" onClick={() => setLang(lang.value === 'uz' ? 'ru' : 'uz')}>
            {lang.value === 'uz' ? 'Русский' : 'O\'zbek'}
          </button>
        </div>
      </form>
    </div>
  );
}

// ---------- birinchi sozlash (desktop) ----------

export function SetupPage(): JSX.Element {
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (): Promise<void> => {
    setBusy(true);
    try {
      await api.put('/api/setup', { api_key: key });
      await loadApp();
      navigate('/');
    } catch (e) {
      toast(String((e as Error).message), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="login-wrap">
      <div class="login-card">
        <div class="brand center">
          <Logo size={44} />
          <div class="brand-name big">{app.value?.name ?? 'TTA CLAUDE'}</div>
        </div>
        <h3>{t('setup_title')}</h3>
        <p class="muted small">{t('setup_text')}</p>
        <Field label={t('api_key')}>
          <input class="input" type="password" placeholder="sk-ant-…" value={key} onInput={(e) => setKey((e.target as HTMLInputElement).value)} autoFocus />
        </Field>
        <button class="btn primary wide" disabled={busy || !key.trim()} onClick={() => void save()}>
          {t('save')}
        </button>
        <div class="row center">
          <button type="button" class="lang-btn" onClick={() => setLang(lang.value === 'uz' ? 'ru' : 'uz')}>
            {lang.value === 'uz' ? 'Русский' : 'O\'zbek'}
          </button>
          <a class="muted small" href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer" onClick={(e) => window.desktop && (e.preventDefault(), void window.desktop.openExternal('https://console.anthropic.com/settings/keys'))}>
            console.anthropic.com ↗
          </a>
        </div>
      </div>
    </div>
  );
}
