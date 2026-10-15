// Markdown → xavfsiz HTML.
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

const renderer = new marked.Renderer();
renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  const cls = lang ? ` class="language-${escapeAttr(lang)}"` : '';
  return `<div class="codeblock"><div class="codebar"><span>${escapeHtml(lang ?? '')}</span><button type="button" class="copy-btn" data-copy>⧉</button></div><pre><code${cls}>${escapeHtml(text)}</code></pre></div>`;
};
renderer.link = ({ href, title, text }: { href: string; title?: string | null; text: string }) => {
  const t = title ? ` title="${escapeAttr(title)}"` : '';
  return `<a href="${escapeAttr(href)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
};
marked.use({ renderer });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export function renderMarkdown(src: string): string {
  const html = marked.parse(src ?? '', { async: false }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'data-copy'] });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

// Nusxalash tugmalari uchun umumiy tinglovchi
document.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button[data-copy]') as HTMLButtonElement | null;
  if (!btn) return;
  const code = btn.closest('.codeblock')?.querySelector('code')?.textContent ?? '';
  void navigator.clipboard.writeText(code).then(() => {
    btn.textContent = '✓';
    setTimeout(() => (btn.textContent = '⧉'), 1200);
  });
});
