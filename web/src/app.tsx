// Ilova qobig'i: marshrutlash, chap panel, sahifalar, bildirishnomalar.
import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Icon } from './icons';
import { t } from './i18n';
import { HomePage, ProjectPage, ProjectsPage, ResultsPage, SessionPage } from './pages';
import { AdminPage, AgentsPage, LoginPage, SchedulesPage, SettingsPage, SetupPage } from './pages2';
import { Sidebar } from './sidebar';
import { app, isAdmin, loadApp, route, sidebarOpen, toasts, user, ws, wsConnected } from './state';
import { Spinner } from './ui';

function Page(): JSX.Element {
  const r = route.value;
  if (r.startsWith('/s/')) return <SessionPage id={r.slice(3)} />;
  if (r === '/projects') return <ProjectsPage />;
  if (r.startsWith('/projects/')) return <ProjectPage id={r.slice('/projects/'.length)} />;
  if (r === '/results') return <ResultsPage />;
  if (r === '/agents') return <AgentsPage />;
  if (r === '/schedules') return <SchedulesPage />;
  if (r === '/settings') return <SettingsPage />;
  if (r === '/admin' && isAdmin.value) return <AdminPage />;
  return <HomePage />;
}

export function App(): JSX.Element {
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => {
    loadApp()
      .then(() => setReady(true))
      .catch((e) => setErr(String((e as Error).message)));
  }, []);
  useEffect(() => {
    if (user.value) ws.connect();
  }, [user.value?.id]);
  if (err)
    return (
      <div class="login-wrap">
        <div class="login-card">
          <div class="sys error">{err}</div>
          <button class="btn" onClick={() => location.reload()}>
            <Icon name="refresh" size={14} /> OK
          </button>
        </div>
      </div>
    );
  if (!ready)
    return (
      <div class="login-wrap">
        <Spinner size={28} />
      </div>
    );
  if (!user.value) return <LoginPage />;
  if (app.value?.setup_required && (app.value.desktop || isAdmin.value) && route.value !== '/settings' && route.value !== '/admin') return <SetupPage />;
  return (
    <div class={`shell ${sidebarOpen.value ? '' : 'nosidebar'}`}>
      <Sidebar />
      <div class="sidebar-back" onClick={() => (sidebarOpen.value = false)} />
      <main class="main">
        {!wsConnected.value && (
          <div class="conn-bar">
            <Spinner size={12} /> {t('disconnected')}
          </div>
        )}
        <Page />
      </main>
      <div class="toasts">
        {toasts.value.map((x) => (
          <div key={x.id} class={`toast ${x.kind}`}>
            {x.text}
          </div>
        ))}
      </div>
    </div>
  );
}
