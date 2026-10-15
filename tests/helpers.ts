// Test yordamchilari: vaqtinchalik ma'lumotlar papkasi bilan ilovani ko'tarish, HTTP/WS mijoz.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createApp, type App } from '../server/app.js';
import { FakeEngine } from './fake-engine.js';
import type { LiveEvent, ServerEnvelope } from '../shared/protocol.js';

export interface TestApp {
  app: App;
  engine: FakeEngine;
  dataDir: string;
  cookie: string;
  api: (method: string, p: string, body?: unknown, raw?: Buffer, headers?: Record<string, string>) => Promise<{ status: number; json: Record<string, unknown>; headers: http.IncomingHttpHeaders; body: Buffer }>;
  login: (login: string, password: string) => Promise<void>;
  ws: () => Promise<WsClient>;
  close: () => Promise<void>;
}

export async function startTestApp(extra: Record<string, unknown> = {}): Promise<TestApp> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-test-'));
  const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-static-'));
  fs.writeFileSync(path.join(staticDir, 'index.html'), '<!doctype html><title>t</title><script>window.BASE="__BASE_PATH__"</script>');
  const engine = new FakeEngine();
  const app = await createApp({
    config: { dataDir, port: 0, host: '127.0.0.1', adminPassword: 'admin123', apiKey: 'sk-ant-test-key-000000000000000000000', hideApiKey: false, idleCloseMs: 60_000, ...extra },
    engine,
    staticDir,
    scheduler: false,
    log: () => {},
  });
  const base = `http://127.0.0.1:${app.port}${app.config.basePath}`;
  const t: TestApp = {
    app,
    engine,
    dataDir,
    cookie: '',
    api: (method, p, body, raw, headers = {}) =>
      new Promise((resolve, reject) => {
        const data = raw ?? (body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined);
        const req = http.request(
          base + p,
          { method, headers: { ...(data && !raw ? { 'content-type': 'application/json' } : {}), ...(data ? { 'content-length': data.length } : {}), cookie: t.cookie, 'sec-fetch-site': 'same-origin', ...headers } },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => {
              const buf = Buffer.concat(chunks);
              let json: Record<string, unknown> = {};
              try {
                json = JSON.parse(buf.toString('utf8')) as Record<string, unknown>;
              } catch {
                /* JSON emas */
              }
              const sc = res.headers['set-cookie'];
              if (sc && sc.length) t.cookie = sc[0].split(';')[0];
              resolve({ status: res.statusCode ?? 0, json, headers: res.headers, body: buf });
            });
          },
        );
        req.on('error', reject);
        if (data) req.write(data);
        req.end();
      }),
    login: async (login, password) => {
      const r = await t.api('POST', '/api/login', { login, password });
      if (r.status !== 200) throw new Error('login failed: ' + JSON.stringify(r.json));
    },
    ws: () => WsClient.connect(`ws://127.0.0.1:${app.port}${app.config.basePath}/ws`, t.cookie),
    close: async () => {
      await app.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.rmSync(staticDir, { recursive: true, force: true });
    },
  };
  return t;
}

export class WsClient {
  events: ServerEnvelope[] = [];
  private waiters: Array<{ pred: (e: ServerEnvelope) => boolean; resolve: (e: ServerEnvelope) => void }> = [];
  private constructor(public ws: WebSocket) {
    ws.on('message', (raw) => {
      const env = JSON.parse(String(raw)) as ServerEnvelope;
      this.events.push(env);
      for (const w of [...this.waiters]) {
        if (w.pred(env)) {
          this.waiters.splice(this.waiters.indexOf(w), 1);
          w.resolve(env);
        }
      }
    });
  }
  static connect(url: string, cookie: string): Promise<WsClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: { cookie } });
      ws.once('open', () => resolve(new WsClient(ws)));
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error('ws status ' + res.statusCode)));
    });
  }
  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }
  wait(pred: (ev: LiveEvent, env: ServerEnvelope) => boolean, timeoutMs = 5000): Promise<ServerEnvelope> {
    const found = this.events.find((e) => pred(e.ev, e));
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws wait timeout: ' + pred.toString().slice(0, 80))), timeoutMs);
      this.waiters.push({
        pred: (e) => pred(e.ev, e),
        resolve: (e) => {
          clearTimeout(timer);
          resolve(e);
        },
      });
    });
  }
  of<T extends LiveEvent['t']>(t: T): Array<Extract<LiveEvent, { t: T }>> {
    return this.events.map((e) => e.ev).filter((e): e is Extract<LiveEvent, { t: T }> => e.t === t);
  }
  close(): void {
    this.ws.close();
  }
}
