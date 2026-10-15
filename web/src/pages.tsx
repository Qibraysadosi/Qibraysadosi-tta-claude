// Sahifalar: bosh (yangi suhbat), suhbat, loyihalar, natijalar.
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import type { Attachment, Project, SessionInfo } from '../../shared/protocol';
import { api } from './api';
import { Composer, MessageList } from './chat';
import { Icon } from './icons';
import { t } from './i18n';
import { FileRow, RightPanel } from './panel';
import { agents, app, currentSession, isDesktop, navigate, openSession, projectById, projects, refreshProjects, refreshSessions, rightPanelOpen, sessions, sidebarOpen, toast, user, ws } from './state';
import { Empty, Field, Modal, fmtBytes, fmtDate } from './ui';

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

// ---------- bosh sahifa: yangi suhbat ----------

export function HomePage(): JSX.Element {
  const u = user.value!;
  const [projectId, setProjectId] = useState<string>(localStorage.getItem('tta.project') || projects.value[0]?.id || '');
  const [agent, setAgent] = useState<string>(() => {
    const a = localStorage.getItem('tta.agent') ?? '';
    localStorage.removeItem('tta.agent');
    return agents.value.some((x) => x.name === a) ? a : '';
  });
  const [newProj, setNewProj] = useState(false);
  useEffect(() => {
    if (!projects.value.some((p) => p.id === projectId)) setProjectId(projects.value[0]?.id ?? '');
  }, [projects.value]);
  const start = async (text: string, atts: Attachment[]): Promise<void> => {
    const r = await api.post<{ session: SessionInfo }>('/api/sessions', { project_id: projectId || undefined, model: u.default_model, mode: u.default_mode, agent: agent || null });
    sessions.value = [r.session, ...sessions.value];
    const view = openSession(r.session.id);
    void view;
    navigate('/s/' + r.session.id);
    // ulanish tayyor bo'lgach yuboramiz
    const trySend = (n: number): void => {
      if (ws.connected) ws.send({ a: 'send', session_id: r.session.id, text, attachments: atts });
      else if (n < 40) setTimeout(() => trySend(n + 1), 150);
    };
    trySend(0);
  };
  const hour = new Date().getHours();
  const recent = sessions.value.slice(0, 6);
  return (
    <div class="page home">
      <TopBar title="" />
      <div class="home-inner">
        <div class="home-hero">
          <h1>{t('welcome', { name: u.name.split(' ')[0] })}</h1>
          <p class="muted">{t('welcome_sub')}</p>
        </div>
        <div class="home-opts">
          <label class="opt">
            <Icon name="folder" size={15} />
            <select class="select" value={projectId} onChange={(e) => (setProjectId((e.target as HTMLSelectElement).value), localStorage.setItem('tta.project', (e.target as HTMLSelectElement).value))}>
              {projects.value.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <button class="btn ghost small" onClick={() => setNewProj(true)}>
            <Icon name="plus" size={14} /> {isDesktop.value ? t('pick_folder') : t('new_project')}
          </button>
          {agents.value.length > 0 && (
            <label class="opt">
              <Icon name="bot" size={15} />
              <select class="select" value={agent} onChange={(e) => setAgent((e.target as HTMLSelectElement).value)}>
                <option value="">{t('model')}: {app.value?.models.find((m) => m.value === u.default_model)?.label ?? u.default_model}</option>
                {agents.value.map((a) => (
                  <option key={a.id} value={a.name}>
                    {t('agents')}: {a.title}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <Composer view={null} onSend={start} projectId={projectId || null} autoFocus />
        {recent.length > 0 && (
          <div class="home-recent">
            <div class="sess-group">{t('recent')}</div>
            {recent.map((s) => (
              <button key={s.id} class="recent-item" onClick={() => navigate('/s/' + s.id)}>
                <Icon name={s.origin === 'schedule' ? 'clock' : 'history'} size={15} />
                <span class="grow">{s.title || t('new_chat')}</span>
                <span class="muted small">{fmtDate(s.updated)}</span>
              </button>
            ))}
          </div>
        )}
        <div class="muted small center">{hour < 12 ? '☀️' : hour < 18 ? '🌤' : '🌙'} {t('model_hint')}</div>
      </div>
      {newProj && <NewProjectModal onClose={() => setNewProj(false)} onCreated={(p) => (setProjectId(p.id), localStorage.setItem('tta.project', p.id))} />}
    </div>
  );
}

export function NewProjectModal({ onClose, onCreated }: { onClose: () => void; onCreated: (p: Project) => void }): JSX.Element {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const pick = async (): Promise<void> => {
    const p = await window.desktop?.pickFolder();
    if (p) {
      setPath(p);
      if (!name) setName(p.split(/[\\/]/).filter(Boolean).pop() ?? '');
    }
  };
  const create = async (): Promise<void> => {
    setBusy(true);
    try {
      const r = await api.post<{ project: Project }>('/api/projects', { name, path: path || undefined });
      await refreshProjects();
      onCreated(r.project);
      onClose();
    } catch (e) {
      toast(String((e as Error).message), 'error');
    } finally {
      setBusy(false);
    }
  };
  const canPath = isDesktop.value || user.value?.role === 'admin';
  return (
    <Modal title={t('new_project')} onClose={onClose}>
      <Field label={t('project_name')}>
        <input class="input" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} autoFocus />
      </Field>
      {canPath && (
        <Field label={t('project_path')} help={isDesktop.value ? t('desktop_folder_hint') : undefined}>
          <div class="row">
            <input class="input grow" value={path} onInput={(e) => setPath((e.target as HTMLInputElement).value)} placeholder={isDesktop.value ? 'C:\\Users\\…' : '/root/…'} />
            {window.desktop && (
              <button class="btn" onClick={() => void pick()}>
                <Icon name="folder" size={14} /> {t('pick_folder')}
              </button>
            )}
          </div>
        </Field>
      )}
      <div class="row end">
        <button class="btn" onClick={onClose}>
          {t('cancel')}
        </button>
        <button class="btn primary" disabled={!name.trim() || busy} onClick={() => void create()}>
          {t('create')}
        </button>
      </div>
    </Modal>
  );
}

// ---------- suhbat sahifasi ----------

export function SessionPage({ id }: { id: string }): JSX.Element {
  useEffect(() => {
    openSession(id);
    return () => {
      /* obunani saqlab qolamiz — fon hodisalari uchun */
    };
  }, [id]);
  const view = currentSession.value;
  if (!view || view.id !== id) return <div class="page" />;
  const send = async (text: string, atts: Attachment[]): Promise<void> => {
    ws.send({ a: 'send', session_id: id, text, attachments: atts });
  };
  const proj = view.info ? projectById.value.get(view.info.project_id) : undefined;
  return (
    <div class="page session">
      <div class="chat-col">
        <TopBar
          title={view.info?.title || t('new_chat')}
          right={
            <>
              {proj && (
                <button class="chip" title={proj.path} onClick={() => navigate('/projects/' + proj.id)}>
                  <Icon name="folder" size={13} /> {proj.name}
                </button>
              )}
              <button class="icon-btn" title={t('results_panel')} onClick={() => ((rightPanelOpen.value = !rightPanelOpen.value), localStorage.setItem('tta.right', rightPanelOpen.value ? '1' : '0'))}>
                <Icon name="panel" />
              </button>
            </>
          }
        />
        {view.loaded ? <MessageList view={view} /> : <div class="messages" />}
        <Composer view={view} onSend={send} projectId={view.info?.project_id ?? null} autoFocus />
      </div>
      <RightPanel view={view} />
    </div>
  );
}

// ---------- loyihalar ----------

export function ProjectsPage(): JSX.Element {
  const [modal, setModal] = useState(false);
  const list = projects.value;
  return (
    <div class="page">
      <TopBar
        title={t('projects')}
        right={
          <button class="btn primary small" onClick={() => setModal(true)}>
            <Icon name="plus" size={14} /> {isDesktop.value ? t('pick_folder') : t('new_project')}
          </button>
        }
      />
      <div class="page-body">
        <div class="cards">
          {list.map((p) => (
            <button key={p.id} class="card" onClick={() => navigate('/projects/' + p.id)}>
              <div class="card-head">
                <Icon name="folder" size={18} />
                <strong>{p.name}</strong>
              </div>
              <div class="muted small mono" title={p.path}>
                {p.path}
              </div>
              <div class="muted small">
                {sessions.value.filter((s) => s.project_id === p.id).length} {t('sessions_count')}
              </div>
            </button>
          ))}
        </div>
      </div>
      {modal && <NewProjectModal onClose={() => setModal(false)} onCreated={(p) => navigate('/projects/' + p.id)} />}
    </div>
  );
}

interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

export function ProjectPage({ id }: { id: string }): JSX.Element {
  const p = projectById.value.get(id);
  const [dir, setDir] = useState('');
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [instr, setInstr] = useState('');
  const [note, setNote] = useState(p?.instructions_note ?? '');
  const [tab, setTab] = useState<'files' | 'instr'>('files');
  const load = async (d = dir): Promise<void> => {
    try {
      const r = await api.get<{ entries: DirEntry[] }>(`/api/projects/${id}/files?path=${encodeURIComponent(d)}`);
      setEntries(r.entries);
      setDir(d);
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  };
  useEffect(() => {
    void load('');
    void api.get<{ text: string }>(`/api/projects/${id}/instructions`).then((r) => setInstr(r.text));
  }, [id]);
  if (!p) return <div class="page" />;
  const upload = async (files: FileList): Promise<void> => {
    for (const f of Array.from(files)) {
      try {
        await api.upload(`/api/projects/${id}/upload?name=${encodeURIComponent(f.name)}`, f);
      } catch (e) {
        toast(String((e as Error).message), 'error');
      }
    }
    await load(dir === '' ? 'uploads' : dir);
  };
  const saveInstr = async (): Promise<void> => {
    await api.put(`/api/projects/${id}/instructions`, { text: instr });
    await api.patch(`/api/projects/${id}`, { instructions_note: note });
    await refreshProjects();
    toast(t('saved'), 'ok');
  };
  const del = async (): Promise<void> => {
    if (!confirm(t('confirm_delete'))) return;
    try {
      await api.del(`/api/projects/${id}`);
      await refreshProjects();
      await refreshSessions();
      navigate('/projects');
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  };
  const crumbs = dir ? dir.split('/') : [];
  return (
    <div class="page">
      <TopBar
        title={p.name}
        right={
          <>
            <button class="btn small" onClick={() => navigate('/')}>
              <Icon name="plus" size={14} /> {t('new_chat')}
            </button>
            {window.desktop && (
              <button class="btn small" onClick={() => void window.desktop!.openPath(p.path)}>
                <Icon name="external" size={14} /> {t('open')}
              </button>
            )}
            {p.kind !== 'workspace' || projects.value.filter((x) => x.kind === 'workspace').length > 1 ? (
              <button class="btn small danger" onClick={() => void del()}>
                <Icon name="trash" size={14} />
              </button>
            ) : null}
          </>
        }
      />
      <div class="page-body">
        <div class="muted small mono">{p.path}</div>
        <div class="tabs">
          <button class={tab === 'files' ? 'on' : ''} onClick={() => setTab('files')}>
            {t('files')}
          </button>
          <button class={tab === 'instr' ? 'on' : ''} onClick={() => setTab('instr')}>
            {t('project_instructions')}
          </button>
        </div>
        {tab === 'files' ? (
          <div class="filebrowser">
            <div class="row">
              <div class="crumbs">
                <button onClick={() => void load('')}>{p.name}</button>
                {crumbs.map((c, i) => (
                  <span key={i}>
                    <span class="muted">/</span>
                    <button onClick={() => void load(crumbs.slice(0, i + 1).join('/'))}>{c}</button>
                  </span>
                ))}
              </div>
              <span class="grow" />
              <label class="btn small">
                <Icon name="upload" size={14} /> {t('upload')}
                <input type="file" multiple hidden onChange={(e) => void upload((e.target as HTMLInputElement).files!)} />
              </label>
            </div>
            {entries.length === 0 && <Empty icon="folder" text={t('folder_empty')} />}
            {entries.map((e) =>
              e.dir ? (
                <button key={e.path} class="file-row dir" onClick={() => void load(e.path)}>
                  <Icon name="folder" size={16} />
                  <span class="file-name">{e.name}</span>
                </button>
              ) : (
                <FileRow key={e.path} projectId={id} file={{ path: e.path, name: e.name, size: e.size }} />
              ),
            )}
          </div>
        ) : (
          <div class="form">
            <Field label={t('project_instructions')} help={t('project_instructions_help')}>
              <textarea class="input" rows={10} value={instr} onInput={(e) => setInstr((e.target as HTMLTextAreaElement).value)} placeholder="# Loyiha\n…" />
            </Field>
            <Field label={t('project') + ' — ' + t('instructions').toLowerCase()}>
              <textarea class="input" rows={3} value={note} onInput={(e) => setNote((e.target as HTMLTextAreaElement).value)} />
            </Field>
            <div class="row end">
              <button class="btn primary" onClick={() => void saveInstr()}>
                {t('save')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- natijalar ----------

export function ResultsPage(): JSX.Element {
  const all = sessions.value.flatMap((s) => s.files.map((f) => ({ f, s })));
  all.sort((a, b) => b.f.mtime - a.f.mtime);
  return (
    <div class="page">
      <TopBar title={t('all_results')} />
      <div class="page-body">
        {all.length === 0 ? (
          <Empty icon="file" text={t('empty_results_page')} />
        ) : (
          <div class="files wide">
            {all.slice(0, 300).map(({ f, s }) => (
              <div key={s.id + f.path} class="file-wrap">
                <FileRow projectId={s.project_id} file={f} from={`${t('from_session')} «${s.title}» · ${fmtDate(f.mtime)} · ${fmtBytes(f.size)}`} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
