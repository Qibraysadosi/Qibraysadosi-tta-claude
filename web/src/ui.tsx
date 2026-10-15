// Kichik umumiy komponentlar.
import type { ComponentChildren, JSX } from 'preact';
import { useEffect } from 'preact/hooks';
import { Icon } from './icons';
import { t } from './i18n';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ComponentChildren; wide?: boolean }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div class="modal-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true">
        <div class="modal-head">
          <h3>{title}</h3>
          <button class="icon-btn" onClick={onClose} aria-label={t('cancel')}>
            <Icon name="x" />
          </button>
        </div>
        <div class="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, children, help }: { label: string; children: ComponentChildren; help?: string }): JSX.Element {
  return (
    <label class="field">
      <span class="field-label">{label}</span>
      {children}
      {help && <span class="field-help">{help}</span>}
    </label>
  );
}

export function Spinner({ size = 16 }: { size?: number }): JSX.Element {
  return <span class="spinner" style={{ width: size, height: size }} />;
}

export function fmtMoney(v: number): string {
  if (!v) return '$0';
  if (v < 0.01) return '<$0.01';
  return '$' + (v < 100 ? v.toFixed(2) : Math.round(v).toString());
}

export function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function fmtDate(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return fmtTime(ts);
  return d.toLocaleDateString([], { day: '2-digit', month: 'short' }) + ' ' + fmtTime(ts);
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return ms + ' ms';
  if (ms < 60_000) return (ms / 1000).toFixed(1) + ' s';
  return Math.round(ms / 60_000) + ' min';
}

export function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return (n / 1_000_000).toFixed(2).replace(/\.?0+$/, '') + 'M';
}

export function Empty({ icon, text }: { icon: string; text: string }): JSX.Element {
  return (
    <div class="empty">
      <Icon name={icon} size={22} />
      <span>{text}</span>
    </div>
  );
}

export function dayGroup(ts: number): 'today' | 'yesterday' | 'earlier' {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'yesterday';
  return 'earlier';
}
