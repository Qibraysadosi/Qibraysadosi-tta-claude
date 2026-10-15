// O'ng panel: Jarayon (reja), Natijalar (fayllar), Agentlar, Sessiyada ishlatilgan.
import type { ComponentChildren, JSX } from 'preact';
import { useState } from 'preact/hooks';
import { api } from './api';
import { Icon } from './icons';
import { t } from './i18n';
import { isDesktop, projectById, rightPanelOpen, toast, type SessionView } from './state';
import { Empty, fmtBytes, fmtMoney, fmtTokens, fmtDuration } from './ui';

function Section({ title, children, defaultOpen = true, count }: { title: string; children: ComponentChildren; defaultOpen?: boolean; count?: number }): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div class="psec">
      <button class="psec-head" onClick={() => setOpen(!open)}>
        <span>{title}</span>
        {count !== undefined && count > 0 && <span class="pcount">{count}</span>}
        <Icon name="chevdown" size={14} class={`chev ${open ? 'open' : ''}`} />
      </button>
      {open && <div class="psec-body">{children}</div>}
    </div>
  );
}

export function fileIcon(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['xlsx', 'xls', 'csv'].includes(ext)) return 'table';
  if (['docx', 'doc', 'pdf', 'pptx', 'md', 'txt'].includes(ext)) return 'doc';
  return 'file';
}

export function FileRow({ projectId, file, from }: { projectId: string; file: { path: string; name: string; size: number; kind?: string }; from?: string }): JSX.Element {
  const p = projectById.value.get(projectId);
  const abs = p ? p.path.replace(/[\\/]$/, '') + (p.path.includes('\\') ? '\\' : '/') + file.path.replace(/\//g, p.path.includes('\\') ? '\\' : '/') : '';
  return (
    <div class="file-row">
      <Icon name={fileIcon(file.name)} size={16} />
      <div class="file-meta">
        <a class="file-name" href={api.fileUrl(projectId, file.path)} target="_blank" rel="noreferrer" title={file.path}>
          {file.name}
        </a>
        <span class="muted small">
          {fmtBytes(file.size)}
          {file.kind === 'created' ? ' · ' + t('new_version') : ''}
          {from ? ' · ' + from : ''}
        </span>
      </div>
      {isDesktop.value && window.desktop && (
        <button class="icon-btn" title={t('reveal')} onClick={() => void window.desktop!.reveal(abs)}>
          <Icon name="folder" size={15} />
        </button>
      )}
      <a class="icon-btn" title={t('download')} href={api.fileUrl(projectId, file.path, true)} download={file.name}>
        <Icon name="download" size={15} />
      </a>
    </div>
  );
}

export function RightPanel({ view }: { view: SessionView }): JSX.Element {
  const todos = view.todos;
  const done = todos.filter((x) => x.status === 'completed').length;
  const tasks = [...view.tasks.values()].sort((a, b) => a.ts - b.ts);
  const st = view.info?.stats;
  const ctxPct = st && st.context_window ? Math.min(100, Math.round((st.context_tokens / st.context_window) * 100)) : 0;
  const pid = view.info?.project_id ?? '';
  return (
    <aside class={`rpanel ${rightPanelOpen.value ? '' : 'hidden'}`}>
      <div class="rpanel-head">
        <strong>{view.info?.title || t('new_chat')}</strong>
        <button class="icon-btn" onClick={() => ((rightPanelOpen.value = false), localStorage.setItem('tta.right', '0'))} aria-label={t('hide_details')}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <div class="rpanel-scroll">
        <Section title={t('progress')} count={todos.length}>
          {todos.length === 0 ? (
            <Empty icon="list" text={t('no_progress')} />
          ) : (
            <div class="todos">
              <div class="todo-sum muted small">{t('step_of', { n: Math.min(done + 1, todos.length), total: todos.length })}</div>
              {todos.map((td, i) => (
                <div key={i} class={`todo ${td.status}`}>
                  <span class="todo-dot" />
                  <span>{td.status === 'in_progress' && td.activeForm ? td.activeForm : td.content}</span>
                </div>
              ))}
            </div>
          )}
        </Section>
        <Section title={t('results_panel')} count={view.files.length}>
          {view.files.length === 0 ? (
            <Empty icon="file" text={t('no_results')} />
          ) : (
            <div class="files">
              {view.files.map((f) => (
                <FileRow key={f.path} projectId={pid} file={f} />
              ))}
            </div>
          )}
        </Section>
        {tasks.length > 0 && (
          <Section title={t('subagents')} count={tasks.length}>
            <div class="tasks">
              {tasks.map((task) => (
                <div key={task.task_id} class={`task ${task.status}`}>
                  <Icon name="bot" size={14} />
                  <div class="task-meta">
                    <div class="task-desc">{task.description}</div>
                    <div class="muted small">
                      {task.subagent_type ? task.subagent_type + ' · ' : ''}
                      {task.status === 'completed' ? t('done') : task.status === 'failed' ? t('error') : task.status === 'stopped' ? t('interrupted') : t('running')}
                      {task.usage ? ` · ${fmtTokens(task.usage.total_tokens)} tok · ${task.usage.tool_uses} ${t('tools').toLowerCase()} · ${fmtDuration(task.usage.duration_ms)}` : ''}
                    </div>
                    {task.summary && <div class="small">{task.summary}</div>}
                  </div>
                </div>
              ))}
            </div>
          </Section>
        )}
        <Section title={t('used_in_session')}>
          <div class="usage-grid">
            <div>
              <Icon name="upload" size={14} /> {t('uploads')}
            </div>
            <b>{st?.uploads ?? 0}</b>
            <div>
              <Icon name="globe" size={14} /> {t('web_search')}
            </div>
            <b>{st?.web_searches ?? 0}</b>
            <div>
              <Icon name="cpu" size={14} /> {t('tools')}
            </div>
            <b>{st?.tool_uses ?? 0}</b>
            <div>
              <Icon name="layers" size={14} /> {t('tokens')}
            </div>
            <b>
              {fmtTokens(st?.input_tokens ?? 0)} / {fmtTokens(st?.output_tokens ?? 0)}
            </b>
            <div>
              <Icon name="zap" size={14} /> {t('session_cost')}
            </div>
            <b>{fmtMoney(view.info?.cost_usd ?? 0)}</b>
          </div>
          {st && st.context_window > 0 ? (
            <div class="ctx">
              <div class="muted small">
                {t('context')}: {fmtTokens(st.context_tokens)} / {fmtTokens(st.context_window)} ({ctxPct}%)
              </div>
              <div class="bar">
                <div class="bar-fill" style={{ width: ctxPct + '%' }} />
              </div>
            </div>
          ) : null}
          <div class="muted small">
            {t('model')}: {view.model} · {t('mode')}: {t(`mode_${view.mode}` as never)}
          </div>
          {view.info?.project_id && (
            <div class="muted small" title={projectById.value.get(view.info.project_id)?.path}>
              {t('project')}: {projectById.value.get(view.info.project_id)?.name ?? '—'}
            </div>
          )}
        </Section>
      </div>
    </aside>
  );
}

export function copyText(s: string): void {
  void navigator.clipboard.writeText(s).then(() => toast(t('copied'), 'ok'));
}
