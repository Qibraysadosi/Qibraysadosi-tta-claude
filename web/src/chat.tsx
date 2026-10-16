// Suhbat: xabarlar ro'yxati, vosita kartalari, ruxsat/savol/reja kartalari va kiritish paneli.
import type { JSX } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Attachment, ChatEvent, ContentBlock, PermissionMode } from '../../shared/protocol';
import { api } from './api';
import { Icon } from './icons';
import { t } from './i18n';
import { renderMarkdown } from './md';
import { app, composerDraft, currentSession, isAdmin, isDesktop, projectById, toast, ws, type SessionView, type StreamBlock } from './state';
import { Spinner, fmtDuration, fmtMoney, fmtBytes, fmtTime } from './ui';

// ---------- yordamchilar ----------

export const MODES: PermissionMode[] = ['auto', 'acceptEdits', 'default', 'plan', 'bypassPermissions'];

function toolTitle(name: string): string {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return t('tool_bash');
    case 'Read':
      return t('tool_read');
    case 'Write':
      return t('tool_write');
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return t('tool_edit');
    case 'Glob':
      return t('tool_glob');
    case 'Grep':
      return t('tool_grep');
    case 'WebSearch':
      return t('tool_websearch');
    case 'WebFetch':
      return t('tool_webfetch');
    case 'Agent':
      return t('tool_agent');
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return t('tool_todo');
    case 'Skill':
      return t('tool_skill');
    default:
      return name;
  }
}

function toolIcon(name: string): string {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return 'terminal';
    case 'Read':
      return 'eye';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'pen';
    case 'Glob':
    case 'Grep':
      return 'search';
    case 'WebSearch':
    case 'WebFetch':
      return 'globe';
    case 'Agent':
      return 'bot';
    case 'TodoWrite':
      return 'list';
    case 'Skill':
      return 'spark';
    default:
      return 'cpu';
  }
}

function toolSummary(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return String(input.description || input.command || '');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return shortPath(String(input.file_path ?? input.notebook_path ?? ''));
    case 'Glob':
      return String(input.pattern ?? '');
    case 'Grep':
      return String(input.pattern ?? '');
    case 'WebSearch':
      return String(input.query ?? '');
    case 'WebFetch':
      return String(input.url ?? '');
    case 'Agent':
      return String(input.description ?? input.subagent_type ?? '');
    case 'Skill':
      return String(input.skill ?? input.name ?? '');
    default: {
      const first = Object.values(input)[0];
      return typeof first === 'string' ? first.slice(0, 120) : '';
    }
  }
}

function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : p;
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (typeof c === 'string' ? c : (c as { text?: string }).text ?? (c as { type?: string }).type === 'image' ? '[rasm]' : '')).join('\n');
  if (content && typeof content === 'object') return JSON.stringify(content, null, 1);
  return '';
}

// ---------- blok renderlari ----------

function Markdown({ text, streaming }: { text: string; streaming?: boolean }): JSX.Element {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return <div class={`md ${streaming ? 'streaming' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

function ToolCard({ block, view }: { block: { id: string; name: string; input: Record<string, unknown> }; view: SessionView }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const result = view.results.get(block.id);
  const elapsed = view.progress.get(block.id);
  const name = block.name;
  if (name === 'AskUserQuestion' || name === 'ExitPlanMode' || name === 'EnterPlanMode') return null;
  if (name === 'TaskList' || name === 'TaskGet') return null;
  if (name === 'TodoWrite' || name === 'TaskCreate' || name === 'TaskUpdate') {
    return (
      <div class="tool-chip">
        <Icon name="list" size={14} /> {t('tool_todo')}
        {name === 'TaskCreate' && typeof block.input.subject === 'string' ? ': ' + block.input.subject : ''}
      </div>
    );
  }
  const status = result ? (result.is_error ? 'error' : 'done') : view.state === 'idle' ? 'done' : 'running';
  const summary = toolSummary(name, block.input);
  const input = block.input;
  const structured = (result?.structured ?? {}) as Record<string, unknown>;
  return (
    <div class={`tool-card ${status}`}>
      <button class="tool-head" onClick={() => setOpen(!open)}>
        <span class="tool-ic">
          <Icon name={toolIcon(name)} size={15} />
        </span>
        <span class="tool-title">{toolTitle(name)}</span>
        <span class="tool-sum" title={summary}>
          {summary}
        </span>
        <span class={`tool-status ${status}`}>
          {status === 'running' ? <Spinner size={12} /> : status === 'error' ? <Icon name="warn" size={14} /> : <Icon name="check" size={14} />}
          {status === 'running' && elapsed ? ` ${Math.round(elapsed)}s` : ''}
        </span>
        <Icon name="chevdown" size={14} class={`chev ${open ? 'open' : ''}`} />
      </button>
      {open && (
        <div class="tool-body">
          {(name === 'Bash' || name === 'PowerShell') && <pre class="code">$ {String(input.command ?? '')}</pre>}
          {name === 'Write' && <pre class="code small">{String(input.content ?? '').slice(0, 4000)}</pre>}
          {(name === 'Edit' || name === 'MultiEdit') && (
            <div class="diff">
              {typeof input.old_string === 'string' && <pre class="code del">- {input.old_string.slice(0, 2000)}</pre>}
              {typeof input.new_string === 'string' && <pre class="code add">+ {input.new_string.slice(0, 2000)}</pre>}
            </div>
          )}
          {name === 'Agent' && typeof input.prompt === 'string' && <pre class="code small">{input.prompt.slice(0, 2000)}</pre>}
          {!['Bash', 'PowerShell', 'Write', 'Edit', 'MultiEdit', 'Agent'].includes(name) && <pre class="code small">{JSON.stringify(input, null, 1).slice(0, 3000)}</pre>}
          {result && (
            <div class="tool-result">
              <div class="tool-result-label">{result.is_error ? t('tool_error') : t('tool_done')}</div>
              <pre class="code small">{(typeof structured.stdout === 'string' ? structured.stdout + (structured.stderr ? '\n' + String(structured.stderr) : '') : resultText(result.content)).slice(0, 6000) || '—'}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PermissionCard({ ev, view }: { ev: Extract<ChatEvent, { t: 'permission_request' }>; view: SessionView }): JSX.Element {
  const input = (ev.input ?? {}) as Record<string, unknown>;
  const [note, setNote] = useState('');
  const resolved = view.resolved.get(ev.request_id);
  const pending = view.pending.has(ev.request_id);
  const answer = (behavior: 'allow' | 'deny', always = false, updated_input?: unknown): void => {
    ws.send({ a: 'permission', session_id: view.id, request_id: ev.request_id, behavior, always, message: note || undefined, updated_input });
  };
  if (ev.tool === 'AskUserQuestion') return <QuestionCard ev={ev} view={view} pending={pending} resolved={resolved} onAnswer={(answers, response) => answer('allow', false, { questions: input.questions, answers, response })} />;
  if (ev.tool === 'ExitPlanMode') return <PlanCard ev={ev} view={view} pending={pending} resolved={resolved} onAnswer={answer} />;
  return (
    <div class={`perm-card ${pending ? 'pending' : resolved?.behavior ?? ''}`}>
      <div class="perm-head">
        <Icon name={pending ? 'warn' : resolved?.behavior === 'allow' ? 'check' : 'x'} size={16} />
        <strong>{pending ? t('permission_title') : resolved?.behavior === 'allow' ? t('permission_allowed') : t('permission_denied')}</strong>
        <span class="perm-tool">{toolTitle(ev.tool)}</span>
      </div>
      <div class="perm-body">
        {(ev.tool === 'Bash' || ev.tool === 'PowerShell') && <pre class="code">$ {String(input.command ?? '')}</pre>}
        {ev.tool === 'Bash' && input.description ? <div class="muted">{String(input.description)}</div> : null}
        {(ev.tool === 'Write' || ev.tool === 'Edit' || ev.tool === 'Read' || ev.tool === 'MultiEdit') && <div class="mono">{String(input.file_path ?? '')}</div>}
        {ev.tool === 'Write' && typeof input.content === 'string' && <pre class="code small">{input.content.slice(0, 1500)}</pre>}
        {ev.tool === 'Edit' && (
          <div class="diff">
            <pre class="code del">- {String(input.old_string ?? '').slice(0, 1200)}</pre>
            <pre class="code add">+ {String(input.new_string ?? '').slice(0, 1200)}</pre>
          </div>
        )}
        {ev.tool === 'WebFetch' && <div class="mono">{String(input.url ?? '')}</div>}
        {ev.tool === 'WebSearch' && <div class="mono">{String(input.query ?? '')}</div>}
        {!['Bash', 'PowerShell', 'Write', 'Edit', 'Read', 'MultiEdit', 'WebFetch', 'WebSearch'].includes(ev.tool) && <pre class="code small">{JSON.stringify(input, null, 1).slice(0, 1500)}</pre>}
        {ev.reason && <div class="muted small">{ev.reason}</div>}
      </div>
      {pending && (
        <div class="perm-actions">
          <input class="input" placeholder={t('permission_deny_reason')} value={note} onInput={(e) => setNote((e.target as HTMLInputElement).value)} />
          <div class="row">
            <button class="btn primary" onClick={() => answer('allow')}>
              {t('permission_allow')}
            </button>
            <button class="btn" onClick={() => answer('allow', true)}>
              {t('permission_always')}
            </button>
            <button class="btn danger" onClick={() => answer('deny')}>
              {t('permission_deny')}
            </button>
          </div>
        </div>
      )}
      {resolved?.note && <div class="muted small">“{resolved.note}”</div>}
    </div>
  );
}

interface Q {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

function QuestionCard({ ev, pending, resolved, onAnswer }: { ev: Extract<ChatEvent, { t: 'permission_request' }>; view: SessionView; pending: boolean; resolved?: Extract<ChatEvent, { t: 'permission_resolved' }>; onAnswer: (answers: Record<string, string>, response?: string) => void }): JSX.Element {
  const qs = ((ev.input as { questions?: Q[] })?.questions ?? []) as Q[];
  const [sel, setSel] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const toggle = (q: Q, label: string): void => {
    const cur = sel[q.question] ?? [];
    const next = q.multiSelect ? (cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label]) : [label];
    setSel({ ...sel, [q.question]: next });
  };
  const submit = (): void => {
    const answers: Record<string, string> = {};
    for (const q of qs) {
      const o = (other[q.question] ?? '').trim();
      const s = sel[q.question] ?? [];
      answers[q.question] = o ? (s.length && q.multiSelect ? [...s, o].join(', ') : o) : s.join(', ');
    }
    if (Object.values(answers).some((a) => !a)) return;
    onAnswer(answers);
  };
  return (
    <div class={`q-card ${pending ? 'pending' : ''}`}>
      <div class="perm-head">
        <Icon name="info" size={16} />
        <strong>{t('question_title')}</strong>
      </div>
      {qs.map((q) => (
        <div class="q-block" key={q.question}>
          {q.header && <span class="q-header">{q.header}</span>}
          <div class="q-text">{q.question}</div>
          <div class="q-opts">
            {q.options.map((o) => (
              <button key={o.label} class={`q-opt ${(sel[q.question] ?? []).includes(o.label) ? 'on' : ''}`} disabled={!pending} onClick={() => toggle(q, o.label)}>
                <span class="q-label">{o.label}</span>
                {o.description && <span class="q-desc">{o.description}</span>}
              </button>
            ))}
          </div>
          {pending && <input class="input" placeholder={t('question_other')} value={other[q.question] ?? ''} onInput={(e) => setOther({ ...other, [q.question]: (e.target as HTMLInputElement).value })} />}
        </div>
      ))}
      {pending ? (
        <div class="row">
          <button class="btn primary" onClick={submit}>
            {t('question_send')}
          </button>
        </div>
      ) : (
        <div class="muted small">{resolved?.behavior === 'allow' ? t('done') : t('permission_denied')}</div>
      )}
    </div>
  );
}

function PlanCard({ ev, view, pending, resolved, onAnswer }: { ev: Extract<ChatEvent, { t: 'permission_request' }>; view: SessionView; pending: boolean; resolved?: Extract<ChatEvent, { t: 'permission_resolved' }>; onAnswer: (b: 'allow' | 'deny', always?: boolean, updated?: unknown) => void }): JSX.Element {
  const plan = String((ev.input as { plan?: string })?.plan ?? '');
  const [fb, setFb] = useState('');
  const approve = (mode: PermissionMode): void => {
    onAnswer('allow');
    ws.send({ a: 'set_mode', session_id: view.id, mode });
  };
  return (
    <div class={`plan-card ${pending ? 'pending' : ''}`}>
      <div class="perm-head">
        <Icon name="list" size={16} />
        <strong>{t('plan_title')}</strong>
      </div>
      <Markdown text={plan} />
      {pending ? (
        <div class="perm-actions">
          <input class="input" placeholder={t('plan_feedback')} value={fb} onInput={(e) => setFb((e.target as HTMLInputElement).value)} />
          <div class="row">
            <button class="btn primary" onClick={() => approve('auto')}>
              {t('plan_approve_auto')}
            </button>
            <button class="btn" onClick={() => approve('default')}>
              {t('plan_approve_manual')}
            </button>
            <button class="btn danger" onClick={() => ws.send({ a: 'permission', session_id: view.id, request_id: ev.request_id, behavior: 'deny', message: fb || 'Rejani o\'zgartiring' })}>
              {t('plan_reject')}
            </button>
          </div>
        </div>
      ) : (
        <div class="muted small">{resolved?.behavior === 'allow' ? t('permission_allowed') : t('permission_denied')}</div>
      )}
    </div>
  );
}

function StreamBlocks({ blocks }: { blocks: StreamBlock[] }): JSX.Element {
  return (
    <>
      {blocks.map((b, i) =>
        b.type === 'text' ? (
          <Markdown key={i} text={b.text} streaming={!b.done} />
        ) : b.type === 'tool_use' ? (
          <div class="tool-card running" key={i}>
            <div class="tool-head">
              <span class="tool-ic">
                <Icon name={toolIcon(b.name ?? '')} size={15} />
              </span>
              <span class="tool-title">{toolTitle(b.name ?? '')}</span>
              <span class="tool-sum">{partialSummary(b)}</span>
              <span class="tool-status running">
                <Spinner size={12} />
              </span>
            </div>
          </div>
        ) : b.type === 'thinking' ? (
          <div class="thinking" key={i}>
            <Spinner size={12} /> {t('thinking')}
          </div>
        ) : null,
      )}
    </>
  );
}

function partialSummary(b: StreamBlock): string {
  const m = /"(file_path|command|query|url|pattern|description)"\s*:\s*"([^"]{0,120})/.exec(b.partial_json);
  return m ? m[2] : '';
}

// ---------- xabarlar ro'yxati ----------

function AssistantGroup({ items, view }: { items: ChatEvent[]; view: SessionView }): JSX.Element {
  return (
    <div class="turn assistant">
      <div class="turn-body">
        {items.map((ev, i) => {
          if (ev.t === 'assistant') {
            if (ev.parent_tool_use_id) return null; // yordamchi agent ichki xabarlari
            return (
              <div key={ev.id + i} class={ev.aborted ? 'aborted' : ''}>
                {(ev.blocks as ContentBlock[]).map((b, j) =>
                  b.type === 'text' ? <Markdown key={j} text={(b as { text: string }).text} /> : b.type === 'tool_use' ? <ToolCard key={j} block={b as { id: string; name: string; input: Record<string, unknown> }} view={view} /> : null,
                )}
              </div>
            );
          }
          if (ev.t === 'permission_request') return <PermissionCard key={ev.request_id} ev={ev} view={view} />;
          if (ev.t === 'system')
            return (
              <div key={i} class={`sys ${ev.kind}`}>
                <Icon name={ev.kind === 'error' ? 'warn' : 'info'} size={14} /> {ev.text}
              </div>
            );
          if (ev.t === 'task' && ev.status === 'started')
            return (
              <div key={ev.task_id} class="tool-chip agent">
                <Icon name="bot" size={14} /> {ev.subagent_type ? ev.subagent_type + ': ' : ''}
                {ev.description}
              </div>
            );
          if (ev.t === 'result')
            return (
              <div key={i} class="result-line">
                {ev.is_error ? <Icon name="warn" size={12} /> : <Icon name="check" size={12} />}
                <span>{fmtMoney(ev.cost_delta)}</span>
                <span>·</span>
                <span>{fmtDuration(ev.duration_ms)}</span>
                {ev.num_turns > 1 && (
                  <>
                    <span>·</span>
                    <span>
                      {ev.num_turns} {t('turns')}
                    </span>
                  </>
                )}
              </div>
            );
          return null;
        })}
      </div>
    </div>
  );
}

function UserTurn({ ev }: { ev: Extract<ChatEvent, { t: 'user' }> }): JSX.Element {
  const v = currentSession.value;
  const pid = v?.info?.project_id;
  return (
    <div class="turn user">
      <div class="bubble">
        {ev.attachments.length > 0 && (
          <div class="att-list">
            {ev.attachments.map((a) => (
              <a key={a.path} class="att" href={pid ? api.fileUrl(pid, a.path) : '#'} target="_blank" rel="noreferrer">
                <Icon name={a.image ? 'image' : 'file'} size={14} /> {a.name} <span class="muted">{fmtBytes(a.size)}</span>
              </a>
            ))}
          </div>
        )}
        <div class="user-text">{ev.text}</div>
        <div class="turn-time">{fmtTime(ev.ts)}</div>
      </div>
    </div>
  );
}

export function MessageList({ view }: { view: SessionView }): JSX.Element {
  const groups = useMemo(() => {
    const out: Array<{ kind: 'user'; ev: Extract<ChatEvent, { t: 'user' }> } | { kind: 'assistant'; items: ChatEvent[] }> = [];
    for (const ev of view.events) {
      if (ev.t === 'user') out.push({ kind: 'user', ev });
      else if (ev.t === 'init' || ev.t === 'tool_result' || ev.t === 'permission_resolved' || ev.t === 'todos' || ev.t === 'files') continue;
      else {
        const last = out[out.length - 1];
        if (last && last.kind === 'assistant') last.items.push(ev);
        else out.push({ kind: 'assistant', items: [ev] });
      }
    }
    return out;
  }, [view.events, view.version]);
  const endRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    if (stick.current) endRef.current?.scrollIntoView({ block: 'end' });
  }, [view.version]);
  const onScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  };
  return (
    <div class="messages" ref={listRef} onScroll={onScroll}>
      <div class="messages-inner">
        {groups.map((g, i) => (g.kind === 'user' ? <UserTurn key={g.ev.id} ev={g.ev} /> : <AssistantGroup key={i} items={g.items} view={view} />))}
        {view.stream && view.stream.blocks.length > 0 && (
          <div class="turn assistant">
            <div class="turn-body">
              <StreamBlocks blocks={view.stream.blocks} />
            </div>
          </div>
        )}
        {view.state !== 'idle' && !(view.stream && view.stream.blocks.length) && (
          <div class="turn assistant">
            <div class="turn-body">
              <div class="thinking">
                <Spinner size={12} /> {view.status === 'compacting' ? t('compacting') : view.state === 'requires_action' ? t('waiting_you') : t('running')}
              </div>
            </div>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

// ---------- kiritish paneli ----------

export function Composer({ view, onSend, projectId, autoFocus }: { view: SessionView | null; onSend: (text: string, atts: Attachment[]) => Promise<void>; projectId: string | null; autoFocus?: boolean }): JSX.Element {
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const text = composerDraft.value;
  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(220, ta.scrollHeight) + 'px';
  }, [text]);
  const running = view ? view.state !== 'idle' : false;

  const doSend = async (): Promise<void> => {
    const tx = text.trim();
    if ((!tx && !atts.length) || sending || uploading) return;
    setSending(true);
    try {
      await onSend(tx, atts);
      composerDraft.value = '';
      setAtts([]);
      if (running) toast(t('queued_note'));
    } catch (e) {
      toast(String((e as Error).message), 'error');
    } finally {
      setSending(false);
      taRef.current?.focus();
    }
  };

  const upload = async (files: FileList | File[]): Promise<void> => {
    if (!projectId) {
      toast(t('choose_project'), 'error');
      return;
    }
    for (const f of Array.from(files)) {
      setUploading((n) => n + 1);
      try {
        const r = await api.upload<{ attachment: Attachment }>(`/api/projects/${projectId}/upload?name=${encodeURIComponent(f.name)}`, f);
        setAtts((a) => [...a, r.attachment]);
      } catch (e) {
        toast(String((e as Error).message), 'error');
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void doSend();
    }
  };
  const onPaste = (e: ClipboardEvent): void => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length) {
      e.preventDefault();
      void upload(files);
    }
  };
  const onDrop = (e: DragEvent): void => {
    e.preventDefault();
    if (e.dataTransfer?.files.length) void upload(e.dataTransfer.files);
  };

  const models = app.value?.models ?? [];
  const mode = view?.mode ?? 'auto';
  const model = view?.model ?? '';
  const modes = MODES.filter((m) => m !== 'bypassPermissions' || isAdmin.value);

  return (
    <div class="composer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      {atts.length > 0 && (
        <div class="att-list">
          {atts.map((a) => (
            <span class="att" key={a.path}>
              <Icon name={a.image ? 'image' : 'file'} size={14} /> {a.name}
              <button class="att-x" onClick={() => setAtts(atts.filter((x) => x !== a))} aria-label={t('delete')}>
                <Icon name="x" size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
      <textarea ref={taRef} class="composer-input" rows={1} placeholder={t('composer_placeholder')} value={text} onInput={(e) => (composerDraft.value = (e.target as HTMLTextAreaElement).value)} onKeyDown={onKey} onPaste={onPaste} />
      <div class="composer-bar">
        <button class="icon-btn" title={t('attach')} onClick={() => fileRef.current?.click()} disabled={!projectId}>
          {uploading ? <Spinner size={16} /> : <Icon name="paperclip" />}
        </button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => void upload((e.target as HTMLInputElement).files ?? []).then(() => ((e.target as HTMLInputElement).value = ''))} />
        {view && (
          <>
            {view.info?.kind !== 'chat' && (
            <select class="select" value={mode} title={t('mode')} onChange={(e) => ws.send({ a: 'set_mode', session_id: view.id, mode: (e.target as HTMLSelectElement).value as PermissionMode })}>
              {modes.map((m) => (
                <option key={m} value={m} title={t(`mode_${m}_desc` as never)}>
                  {t(`mode_${m}` as never)}
                </option>
              ))}
            </select>
            )}
            <select class="select" value={model} title={t('model')} onChange={(e) => ws.send({ a: 'set_model', session_id: view.id, model: (e.target as HTMLSelectElement).value })}>
              {models.map((m) => (
                <option key={m.value} value={m.value} title={m.description}>
                  {m.label}
                </option>
              ))}
              {model && !models.some((m) => m.value === model) && <option value={model}>{model}</option>}
            </select>
          </>
        )}
        <span class="grow" />
        {running && (
          <button class="btn ghost" onClick={() => view && ws.send({ a: 'interrupt', session_id: view.id })}>
            <Icon name="stop" size={14} /> {t('stop')}
          </button>
        )}
        <button class="btn primary send" onClick={() => void doSend()} disabled={sending || uploading > 0 || (!text.trim() && !atts.length)} title={t('send')}>
          {sending ? <Spinner size={14} /> : <Icon name="send" size={16} />}
        </button>
      </div>
      {isDesktop.value && !projectId && <div class="muted small">{t('desktop_folder_hint')}</div>}
      {projectId && !view && <div class="muted small">{projectById.value.get(projectId)?.path}</div>}
    </div>
  );
}
