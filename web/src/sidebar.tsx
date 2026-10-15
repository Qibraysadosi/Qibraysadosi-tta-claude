// Chap panel: brend, qidiruv, yangi suhbat, bo'limlar, qadalgan va so'nggi suhbatlar, foydalanuvchi.
import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { api } from './api';
import { Icon, Logo } from './icons';
import { t, lang, setLang } from './i18n';
import { app, isAdmin, navigate, projectById, refreshSessions, route, sessions, sidebarOpen, theme, applyTheme, user, toast } from './state';
import { dayGroup } from './ui';
import type { SessionInfo } from '../../shared/protocol';

function NavItem({ icon, label, to, active }: { icon: string; label: string; to: string; active: boolean }): JSX.Element {
  return (
    <button class={`nav ${active ? 'active' : ''}`} onClick={() => navigate(to)}>
      <Icon name={icon} size={17} />
      <span>{label}</span>
    </button>
  );
}

function SessionItem({ s, active }: { s: SessionInfo; active: boolean }): JSX.Element {
  const [menu, setMenu] = useState(false);
  const proj = projectById.value.get(s.project_id);
  const busy = s.state === 'running' || s.state === 'requires_action';
  const act = async (fn: () => Promise<unknown>): Promise<void> => {
    setMenu(false);
    try {
      await fn();
      await refreshSessions();
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  };
  return (
    <div class={`sess ${active ? 'active' : ''}`}>
      <button class="sess-main" onClick={() => navigate('/s/' + s.id)} title={s.title}>
        <span class={`sess-dot ${busy ? s.state : ''}`} />
        <span class="sess-title">{s.title || t('new_chat')}</span>
        {proj && proj.kind !== 'workspace' && <span class="sess-proj">{proj.name}</span>}
      </button>
      <button class="icon-btn sess-more" onClick={() => setMenu(!menu)} aria-label="…">
        ⋯
      </button>
      {menu && (
        <div class="menu" onMouseLeave={() => setMenu(false)}>
          <button onClick={() => void act(() => api.patch(`/api/sessions/${s.id}`, { pinned: !s.pinned }))}>{s.pinned ? t('unpin') : t('pin')}</button>
          <button
            onClick={() => {
              const title = prompt(t('rename'), s.title);
              if (title !== null) void act(() => api.patch(`/api/sessions/${s.id}`, { title }));
            }}
          >
            {t('rename')}
          </button>
          <button class="danger" onClick={() => confirm(t('confirm_delete')) && void act(() => api.del(`/api/sessions/${s.id}`).then(() => active && navigate('/')))}>
            {t('delete')}
          </button>
        </div>
      )}
    </div>
  );
}

export function Sidebar(): JSX.Element {
  const [q, setQ] = useState('');
  const r = route.value;
  const activeId = r.startsWith('/s/') ? r.slice(3) : '';
  const list = sessions.value.filter((s) => !q || (s.title || '').toLowerCase().includes(q.toLowerCase()));
  const pinned = list.filter((s) => s.pinned);
  const rest = list.filter((s) => !s.pinned);
  const groups: Record<string, SessionInfo[]> = { today: [], yesterday: [], earlier: [] };
  for (const s of rest) groups[dayGroup(s.updated)].push(s);
  const u = user.value;
  return (
    <aside class={`sidebar ${sidebarOpen.value ? '' : 'collapsed'}`}>
      <div class="brand">
        <Logo size={30} />
        <div class="brand-text">
          <div class="brand-name">{app.value?.name ?? 'TTA CLAUDE'}</div>
          <div class="brand-sub">{t('powered')}</div>
        </div>
        <button class="icon-btn hide-desktop" onClick={() => (sidebarOpen.value = false)} aria-label={t('hide_details')}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div class="search">
        <Icon name="search" size={15} />
        <input placeholder={t('search')} value={q} onInput={(e) => setQ((e.target as HTMLInputElement).value)} />
      </div>
      <button class="btn primary new-chat" onClick={() => navigate('/')}>
        <Icon name="plus" size={16} /> {t('new_chat')}
      </button>
      <nav class="navs">
        <NavItem icon="folder" label={t('projects')} to="/projects" active={r.startsWith('/projects')} />
        <NavItem icon="file" label={t('results')} to="/results" active={r === '/results'} />
        <NavItem icon="bot" label={t('agents')} to="/agents" active={r === '/agents'} />
        <NavItem icon="clock" label={t('schedules')} to="/schedules" active={r === '/schedules'} />
        <NavItem icon="sliders" label={t('personalization')} to="/settings" active={r === '/settings'} />
        {isAdmin.value && <NavItem icon="users" label={t('admin')} to="/admin" active={r === '/admin'} />}
      </nav>
      <div class="sess-list">
        {pinned.length > 0 && (
          <>
            <div class="sess-group">{t('pinned')}</div>
            {pinned.map((s) => (
              <SessionItem key={s.id} s={s} active={s.id === activeId} />
            ))}
          </>
        )}
        {(['today', 'yesterday', 'earlier'] as const).map((g) =>
          groups[g].length ? (
            <div key={g}>
              <div class="sess-group">{g === 'today' ? t('today') : g === 'yesterday' ? t('yesterday') : t('earlier')}</div>
              {groups[g].map((s) => (
                <SessionItem key={s.id} s={s} active={s.id === activeId} />
              ))}
            </div>
          ) : null,
        )}
        {list.length === 0 && <div class="muted small pad">{t('no_sessions')}</div>}
      </div>
      <div class="sidebar-foot">
        <div class="user-chip" title={u?.login}>
          <span class="avatar">{(u?.name ?? '?').slice(0, 1).toUpperCase()}</span>
          <span class="user-name">{u?.name}</span>
        </div>
        <button class="icon-btn" title={t('theme')} onClick={() => ((theme.value = theme.value === 'dark' ? 'light' : 'dark'), applyTheme(), void api.patch('/api/me', { theme: theme.value }))}>
          <Icon name={document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </button>
        <button class="lang-btn" onClick={() => void switchLang()}>
          {lang.value.toUpperCase()}
        </button>
        {!app.value?.desktop && (
          <button class="icon-btn" title={t('logout')} onClick={() => void api.post('/api/logout').then(() => location.reload())}>
            <Icon name="logout" size={16} />
          </button>
        )}
      </div>
    </aside>
  );
}

async function switchLang(): Promise<void> {
  const next = lang.value === 'uz' ? 'ru' : 'uz';
  setLang(next);
  try {
    await api.patch('/api/me', { lang: next });
  } catch {
    /* oflayn */
  }
}
