// Sozlamalar: .env / muhit o'zgaruvchilari + DATA_DIR/config.json (UI orqali o'rnatiladigan qiymatlar).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { PermissionMode } from '../shared/protocol.js';

export interface AppConfig {
  appName: string;
  version: string;
  dataDir: string;
  host: string;
  port: number;
  basePath: string; // '' yoki '/claude'
  desktop: boolean;
  apiKey: string; // haqiqiy kalit (faqat server xotirasida)
  apiBaseUrl: string; // Anthropic API manzili (proksi uchun yuqori oqim)
  hideApiKey: boolean; // kichik proksi orqali kalitni subprotsessdan yashirish
  defaultModel: string;
  defaultMode: PermissionMode;
  idleCloseMs: number;
  maxUploadBytes: number;
  sessionSecret: string;
  cookieSecure: boolean;
  adminLogin: string;
  adminPassword: string; // faqat birinchi ishga tushishda (bo'sh bo'lsa tasodifiy yaratiladi)
  timezone: string;
  claudeBinary: string; // bo'sh = SDK bilan kelgan
  allowBypass: boolean; // 'bypassPermissions' rejimiga ruxsat (faqat admin)
  publicUrl: string;
}

function envStr(name: string, def = ''): string {
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}
function envInt(name: string, def: number): number {
  const v = parseInt(envStr(name, ''), 10);
  return Number.isFinite(v) ? v : def;
}
function envBool(name: string, def: boolean): boolean {
  const v = envStr(name, '').toLowerCase();
  if (!v) return def;
  return v === '1' || v === 'true' || v === 'yes' || v === 'ha';
}

export function loadDotEnv(file: string): void {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export interface StoredConfig {
  apiKey?: string;
  defaultModel?: string;
  sessionSecret?: string;
  appName?: string;
}

export function readStoredConfig(dataDir: string): StoredConfig {
  const f = path.join(dataDir, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8')) as StoredConfig;
  } catch {
    return {};
  }
}

export function writeStoredConfig(dataDir: string, patch: StoredConfig): StoredConfig {
  const cur = readStoredConfig(dataDir);
  const next = { ...cur, ...patch };
  fs.mkdirSync(dataDir, { recursive: true });
  const f = path.join(dataDir, 'config.json');
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
  return next;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = overrides.dataDir ?? path.resolve(envStr('DATA_DIR', 'data'));
  fs.mkdirSync(dataDir, { recursive: true });
  const stored = readStoredConfig(dataDir);
  let sessionSecret = envStr('SESSION_SECRET', stored.sessionSecret ?? '');
  if (!sessionSecret) {
    sessionSecret = crypto.randomBytes(32).toString('hex');
    writeStoredConfig(dataDir, { sessionSecret });
  }
  let basePath = envStr('BASE_PATH', '').trim();
  if (basePath && !basePath.startsWith('/')) basePath = '/' + basePath;
  basePath = basePath.replace(/\/+$/, '');
  const version = readVersion();
  const cfg: AppConfig = {
    appName: envStr('APP_NAME', stored.appName ?? 'TTA CLAUDE'),
    version,
    dataDir,
    host: envStr('HOST', '127.0.0.1'),
    port: envInt('PORT', 8095),
    basePath,
    desktop: false,
    apiKey: envStr('ANTHROPIC_API_KEY', stored.apiKey ?? ''),
    apiBaseUrl: envStr('ANTHROPIC_UPSTREAM_URL', 'https://api.anthropic.com'),
    hideApiKey: envBool('HIDE_API_KEY', true),
    defaultModel: envStr('DEFAULT_MODEL', stored.defaultModel ?? 'sonnet'),
    defaultMode: (envStr('DEFAULT_MODE', 'auto') as PermissionMode) || 'auto',
    idleCloseMs: envInt('IDLE_CLOSE_MINUTES', 20) * 60_000,
    maxUploadBytes: envInt('MAX_UPLOAD_MB', 200) * 1024 * 1024,
    sessionSecret,
    cookieSecure: envBool('COOKIE_SECURE', false),
    adminLogin: envStr('ADMIN_LOGIN', 'admin'),
    adminPassword: envStr('ADMIN_PASSWORD', ''),
    timezone: envStr('TZ', 'Asia/Tashkent'),
    claudeBinary: envStr('CLAUDE_BINARY', ''),
    allowBypass: envBool('ALLOW_BYPASS', true),
    publicUrl: envStr('PUBLIC_URL', ''),
    ...overrides,
  };
  return cfg;
}

export function readVersion(): string {
  const candidates = [
    path.resolve('VERSION'),
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'VERSION'),
  ];
  for (const f of candidates) {
    try {
      return fs.readFileSync(f, 'utf8').trim();
    } catch {
      /* keyingisi */
    }
  }
  return '0.0.0';
}
