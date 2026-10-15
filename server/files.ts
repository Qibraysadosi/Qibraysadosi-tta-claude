// Loyiha papkasidagi fayllar: xavfsiz yo'l, ro'yxat, o'zgarishlarni aniqlash, yuklash.
import fs from 'node:fs';
import path from 'node:path';
import type { ResultFile } from '../shared/protocol.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', '__pycache__', '.venv', 'venv', '.cache', 'dist', '.next', '.tta']);
const MAX_SCAN = 6000;

export class PathError extends Error {}

/** Nisbiy yo'lni loyiha ichida absolyutga aylantiradi; tashqariga chiqishga yo'l qo'ymaydi. */
export function safeResolve(root: string, rel: string): string {
  const cleaned = (rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(root, cleaned);
  const rootAbs = path.resolve(root);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) throw new PathError('Yo\'l loyiha tashqarisida');
  return abs;
}

export function relPath(root: string, abs: string): string {
  return path.relative(path.resolve(root), abs).split(path.sep).join('/');
}

export function isInside(root: string, abs: string): boolean {
  const rootAbs = path.resolve(root);
  const a = path.resolve(abs);
  return a === rootAbs || a.startsWith(rootAbs + path.sep);
}

export interface DirEntry {
  name: string;
  path: string;
  dir: boolean;
  size: number;
  mtime: number;
}

export function listDir(root: string, rel: string): DirEntry[] {
  const abs = safeResolve(root, rel);
  const out: DirEntry[] = [];
  for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
    if (d.name.startsWith('.') && d.name !== '.claude') continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(path.join(abs, d.name));
    } catch {
      continue;
    }
    out.push({
      name: d.name,
      path: relPath(root, path.join(abs, d.name)),
      dir: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      mtime: st.mtimeMs,
    });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return out;
}

/** `since` dan keyin o'zgargan fayllar (Bash orqali yaratilganlarni ham topish uchun). */
export function scanChanged(root: string, since: number, limit = 60): ResultFile[] {
  const out: ResultFile[] = [];
  let seen = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 5 || seen > MAX_SCAN || out.length >= limit) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (out.length >= limit) return;
      seen++;
      if (d.isDirectory()) {
        if (SKIP_DIRS.has(d.name) || d.name.startsWith('.')) continue;
        walk(path.join(dir, d.name), depth + 1);
      } else if (d.isFile()) {
        if (d.name.startsWith('.')) continue;
        let st: fs.Stats;
        try {
          st = fs.statSync(path.join(dir, d.name));
        } catch {
          continue;
        }
        if (st.mtimeMs >= since - 1000) {
          out.push({
            path: relPath(root, path.join(dir, d.name)),
            name: d.name,
            size: st.size,
            mtime: st.mtimeMs,
            kind: st.birthtimeMs >= since - 1000 ? 'created' : 'modified',
          });
        }
      }
    }
  };
  walk(path.resolve(root), 0);
  return out;
}

export function statFile(root: string, rel: string): ResultFile | null {
  try {
    const abs = safeResolve(root, rel);
    const st = fs.statSync(abs);
    if (!st.isFile()) return null;
    return { path: relPath(root, abs), name: path.basename(abs), size: st.size, mtime: st.mtimeMs, kind: 'modified' };
  } catch {
    return null;
  }
}

export function safeName(name: string): string {
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f<>:"|?*]/g, '_').trim();
  return base || 'fayl';
}

export function uniqueName(dir: string, name: string): string {
  let candidate = name;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${stem}-${i}${ext}`;
    i++;
  }
  return candidate;
}

export function mimeOf(name: string): string {
  const ext = path.extname(name).toLowerCase();
  const map: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain; charset=utf-8',
    '.md': 'text/markdown; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.json': 'application/json',
    '.html': 'text/html; charset=utf-8',
    '.htm': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.zip': 'application/zip',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.woff2': 'font/woff2',
    '.ico': 'image/x-icon',
  };
  return map[ext] ?? 'application/octet-stream';
}

export function isImageName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name);
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}
