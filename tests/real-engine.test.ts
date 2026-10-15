// Haqiqiy Claude Code binari (SDK) + soxta Anthropic API: to'liq integratsiya.
// Og'ir (binar ishga tushadi), shuning uchun faqat RUN_REAL=1 bo'lganda bajariladi.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createApp, type App } from '../server/app.js';
import { startFakeAnthropic, type FakeApi } from './fake-anthropic.js';
import type { ChatEvent, SessionInfo, ServerEnvelope, LiveEvent } from '../shared/protocol.js';

const RUN = process.env.RUN_REAL === '1';

describe('haqiqiy dvigatel (soxta API bilan)', { skip: !RUN }, () => {
  let app: App;
  let api: FakeApi;
  let dataDir: string;
  let cookie = '';
  const logs: string[] = [];

  const call = (method: string, p: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> =>
    new Promise((resolve, reject) => {
      const data = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
      const req = http.request(`http://127.0.0.1:${app.port}${p}`, { method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': data.length } : {}), cookie, 'sec-fetch-site': 'same-origin' } }, (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => {
          const sc = res.headers['set-cookie'];
          if (sc?.length) cookie = sc[0].split(';')[0];
          resolve({ status: res.statusCode ?? 0, json: s ? JSON.parse(s) : {} });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });

  before(async () => {
    api = await startFakeAnthropic();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-real-'));
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tta-static-'));
    fs.writeFileSync(path.join(staticDir, 'index.html'), '<title>x</title>');
    app = await createApp({
      config: { dataDir, port: 0, host: '127.0.0.1', adminPassword: 'admin123', apiKey: 'sk-ant-api03-fake-key-for-integration-test-0000', apiBaseUrl: api.url, hideApiKey: true, idleCloseMs: 120_000 },
      staticDir,
      scheduler: false,
      log: (m, ...r) => logs.push([m, ...r.map(String)].join(' ')),
    });
    await call('POST', '/api/login', { login: 'admin', password: 'admin123' });
  });
  after(async () => {
    await app.close();
    api.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('salom → oqim → javob → narx; keyin Bash ruxsati → natija', async () => {
    const created = await call('POST', '/api/sessions', { model: 'sonnet', mode: 'default' });
    const s = created.json.session as SessionInfo;
    const ws = new WebSocket(`ws://127.0.0.1:${app.port}/ws`, { headers: { cookie } });
    const events: ServerEnvelope[] = [];
    const waiters: Array<{ pred: (e: LiveEvent) => boolean; resolve: () => void }> = [];
    ws.on('message', (raw) => {
      const env = JSON.parse(String(raw)) as ServerEnvelope;
      events.push(env);
      for (const w of [...waiters]) if (w.pred(env.ev)) (waiters.splice(waiters.indexOf(w), 1), w.resolve());
    });
    const wait = (pred: (e: LiveEvent) => boolean, ms = 90_000): Promise<void> =>
      events.some((e) => pred(e.ev)) ? Promise.resolve() : new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout; loglar:\n' + logs.slice(-30).join('\n') + '\nhodisalar: ' + events.map((e) => e.ev.t).join(','))), ms);
        waiters.push({ pred, resolve: () => (clearTimeout(t), resolve()) });
      });
    await new Promise<void>((r) => ws.once('open', () => r()));
    ws.send(JSON.stringify({ a: 'subscribe', session_id: s.id }));
    await wait((e) => e.t === 'history');
    ws.send(JSON.stringify({ a: 'send', session_id: s.id, text: 'Salom, kimsan?' }));
    await wait((e) => e.t === 'result');
    const init = events.map((e) => e.ev).find((e) => e.t === 'init') as Extract<ChatEvent, { t: 'init' }>;
    assert.ok(init, 'init kelishi kerak');
    assert.ok(init.tools.includes('Bash'), 'vositalar ro\'yxatida Bash');
    const assistant = events.map((e) => e.ev).filter((e) => e.t === 'assistant') as Array<Extract<ChatEvent, { t: 'assistant' }>>;
    const text = assistant.flatMap((a) => a.blocks).filter((b) => b.type === 'text').map((b) => (b as { text: string }).text).join('');
    assert.match(text, /soxta API/);
    assert.ok(events.some((e) => e.ev.t === 'stream'), 'oqim hodisalari');
    const req = api.requests.find((r) => r.path.startsWith('/v1/messages') && !r.path.includes('count'));
    assert.ok(req, 'API ga so\'rov borishi kerak');
    assert.equal(req!.headers['x-api-key'], 'sk-ant-api03-fake-key-for-integration-test-0000', 'proksi haqiqiy kalitni qo\'yadi');
    const sysPrompt = JSON.stringify(req!.body.system ?? '');
    assert.match(sysPrompt, /TTA CLAUDE/, 'tizim promptida ilova nomi');
    // ikkinchi tur: vosita + ruxsat
    ws.send(JSON.stringify({ a: 'send', session_id: s.id, text: 'vosita ishlat' }));
    await wait((e) => e.t === 'permission_request');
    const pr = events.map((e) => e.ev).find((e) => e.t === 'permission_request') as Extract<ChatEvent, { t: 'permission_request' }>;
    assert.equal(pr.tool, 'Bash');
    assert.match((pr.input as { command: string }).command, /salom/);
    ws.send(JSON.stringify({ a: 'permission', session_id: s.id, request_id: pr.request_id, behavior: 'allow' }));
    await wait((e) => e.t === 'tool_result');
    const tr = events.map((e) => e.ev).find((e) => e.t === 'tool_result') as Extract<ChatEvent, { t: 'tool_result' }>;
    assert.match(JSON.stringify(tr.content), /salom/);
    await wait((e) => e.t === 'result' && (events.filter((x) => x.ev.t === 'result').length >= 2));
    // uchinchi tur: TaskCreate/TaskUpdate → jarayon paneli
    ws.send(JSON.stringify({ a: 'send', session_id: s.id, text: 'reja tuz' }));
    await wait((e) => e.t === 'todos' && e.items.length === 1 && e.items[0].status === 'completed');
    const todos = events.map((e) => e.ev).filter((e) => e.t === 'todos') as Array<Extract<ChatEvent, { t: 'todos' }>>;
    assert.equal(todos[0].items[0].content, 'Birinchi qadam');
    assert.ok(todos[0].items[0].id, 'vazifa raqami tool_result dan olinadi');
    await wait((e) => e.t === 'result' && events.filter((x) => x.ev.t === 'result').length >= 3);
    const info = await call('GET', `/api/sessions/${s.id}`);
    assert.equal((info.json.session as SessionInfo).turns, 3);
    assert.equal((info.json.todos as unknown[]).length, 1);
    assert.ok((info.json.session as SessionInfo).sdk_session_id);
    ws.close();
  });
});
