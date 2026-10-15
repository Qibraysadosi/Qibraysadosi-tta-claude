// HTTP: kichik marshrutlovchi, JSON/raw tana, cookie autentifikatsiya, statik fayllar.
import type { IncomingMessage, ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';
import { COOKIE_NAME, SESSION_TTL_MS, makeToken, parseCookies, parseToken, verifyPassword } from './auth.js';
import { Service, ServiceError } from './service.js';
import { publicUser, type UserRecord } from './store.js';
import { mimeOf } from './files.js';
import { registerApi } from './api.js';

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  user: UserRecord | null;
  service: Service;
  json<T = unknown>(): Promise<T>;
  raw(limit: number): Promise<Buffer>;
  send(status: number, body: unknown): void;
  setCookie(name: string, value: string, maxAgeSec: number): void;
}

export type Handler = (c: Ctx) => Promise<unknown> | unknown;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
  auth: 'none' | 'user' | 'admin';
}

export class Router {
  routes: Route[] = [];
  add(method: string, pathPattern: string, auth: Route['auth'], handler: Handler): void {
    const keys: string[] = [];
    const re = new RegExp(
      '^' +
        pathPattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_m, k: string) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '$',
    );
    this.routes.push({ method, pattern: re, keys, handler, auth });
  }
  match(method: string, pathname: string): { route: Route; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return null;
  }
}

export interface HttpOptions {
  service: Service;
  staticDir: string;
  desktopToken?: string; // desktop rejimi: tokenli avtomatik kirish
}

export function createHttpHandler(opts: HttpOptions): { handle: (req: IncomingMessage, res: ServerResponse) => void; authenticate: (req: IncomingMessage) => UserRecord | null } {
  const { service } = opts;
  const cfg = service.config;
  const router = new Router();
  registerApi(router, service, opts);

  function authenticate(req: IncomingMessage): UserRecord | null {
    if (opts.desktopToken) {
      // Desktop: yagona foydalanuvchi — token so'rov sarlavhasida yoki cookie'da
      const cookies = parseCookies(req);
      const given = cookies['tta_desktop'] ?? (req.headers['x-desktop-token'] as string | undefined);
      if (given !== opts.desktopToken) return null;
      const admin = service.store.users.all().find((u) => u.role === 'admin');
      return admin ?? null;
    }
    const cookies = parseCookies(req);
    const sess = parseToken(cfg.sessionSecret, cookies[COOKIE_NAME]);
    if (!sess) return null;
    const u = service.store.users.get(sess.uid);
    return u && u.active ? u : null;
  }

  function handle(req: IncomingMessage, res: ServerResponse): void {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://local');
    let pathname = url.pathname;
    if (cfg.basePath) {
      if (pathname === cfg.basePath) {
        res.writeHead(302, { location: cfg.basePath + '/' });
        res.end();
        return;
      }
      if (!pathname.startsWith(cfg.basePath + '/')) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      pathname = pathname.slice(cfg.basePath.length);
    }
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'same-origin');

    if (pathname.startsWith('/api/')) {
      void handleApi(req, res, url, pathname).catch((e: unknown) => {
        service.log('[http] xato', e);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: String((e as Error)?.message ?? e) });
      });
      return;
    }
    serveStatic(res, pathname, opts.staticDir, cfg.basePath, opts.desktopToken, url);
    if (process.env.HTTP_LOG) service.log(`[http] ${req.method} ${pathname} ${Date.now() - started}ms`);
  }

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL, pathname: string): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    const m = router.match(method, pathname);
    if (!m) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    // Oddiy CSRF himoyasi: o'zgartiruvchi so'rovlarda Origin/ Sec-Fetch-Site tekshiruvi
    if (method !== 'GET' && method !== 'HEAD') {
      const site = req.headers['sec-fetch-site'];
      const origin = req.headers['origin'];
      const host = req.headers['host'];
      if (site && site !== 'same-origin' && site !== 'none') {
        sendJson(res, 403, { error: 'csrf' });
        return;
      }
      if (!site && origin && host && !origin.endsWith('//' + host)) {
        sendJson(res, 403, { error: 'csrf' });
        return;
      }
    }
    const user = authenticate(req);
    if (m.route.auth !== 'none') {
      if (!user) {
        sendJson(res, 401, { error: 'unauthorized' });
        return;
      }
      if (m.route.auth === 'admin' && user.role !== 'admin') {
        sendJson(res, 403, { error: 'forbidden' });
        return;
      }
    }
    const ctx: Ctx = {
      req,
      res,
      url,
      params: m.params,
      user,
      service,
      json: async <T,>() => {
        const buf = await readBody(req, 2 * 1024 * 1024);
        if (!buf.length) return {} as T;
        try {
          return JSON.parse(buf.toString('utf8')) as T;
        } catch {
          throw new ServiceError(400, 'bad_json', 'JSON noto\'g\'ri');
        }
      },
      raw: (limit) => readBody(req, limit),
      send: (status, body) => sendJson(res, status, body),
      setCookie: (name, value, maxAgeSec) => {
        const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${cfg.basePath || '/'}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
        if (cfg.cookieSecure) parts.push('Secure');
        res.setHeader('set-cookie', parts.join('; '));
      },
    };
    try {
      const out = await m.route.handler(ctx);
      if (!res.headersSent && !res.writableEnded) sendJson(res, 200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof ServiceError) sendJson(res, e.status, { error: e.code, message: e.message });
      else throw e;
    }
  }

  return { handle, authenticate };
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, 'cache-control': 'no-store' });
  res.end(data);
}

export function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new ServiceError(413, 'too_large', 'So\'rov juda katta'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(res: ServerResponse, pathname: string, dir: string, basePath: string, desktopToken: string | undefined, url: URL): void {
  let rel = pathname === '/' ? '/index.html' : pathname;
  let abs = path.resolve(dir, '.' + rel);
  if (!abs.startsWith(path.resolve(dir) + path.sep) && abs !== path.resolve(dir, 'index.html')) {
    res.writeHead(404);
    res.end();
    return;
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    // SPA: noma'lum yo'llar index.html ga
    rel = '/index.html';
    abs = path.resolve(dir, 'index.html');
    if (!fs.existsSync(abs)) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Web interfeys qurilmagan (npm run build:web)');
      return;
    }
  }
  const headers: Record<string, string> = { 'content-type': mimeOf(abs) };
  if (rel === '/index.html') {
    headers['cache-control'] = 'no-store';
    // Desktop: ?token=... bilan ochilganda cookie o'rnatamiz
    const t = url.searchParams.get('token');
    if (desktopToken && t === desktopToken) headers['set-cookie'] = `tta_desktop=${desktopToken}; Path=/; HttpOnly; SameSite=Lax`;
    let html = fs.readFileSync(abs, 'utf8');
    html = html.replace('__BASE_PATH__', basePath);
    const buf = Buffer.from(html);
    headers['content-length'] = String(buf.length);
    res.writeHead(200, headers);
    res.end(buf);
    return;
  }
  headers['cache-control'] = rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=300';
  res.writeHead(200, headers);
  fs.createReadStream(abs).pipe(res);
}

export function loginUser(c: Ctx, user: UserRecord): void {
  const token = makeToken(c.service.config.sessionSecret, user.id, SESSION_TTL_MS);
  c.setCookie(COOKIE_NAME, token, SESSION_TTL_MS / 1000);
}

export function checkLogin(service: Service, login: string, password: string): UserRecord {
  const u = service.store.userByLogin(login);
  if (!u || !u.active || !verifyPassword(password, u.pass_hash)) throw new ServiceError(401, 'bad_credentials', 'Login yoki parol noto\'g\'ri');
  return u;
}

export { publicUser };
