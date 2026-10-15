import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import type { ChatEvent, SessionInfo } from '../shared/protocol.js';

describe('server', () => {
  let t: TestApp;
  before(async () => {
    t = await startTestApp();
  });
  after(async () => {
    await t.close();
  });

  test('app info va login', async () => {
    const info = await t.api('GET', '/api/app');
    assert.equal(info.status, 200);
    assert.equal(info.json.name, 'TTA CLAUDE');
    assert.equal(info.json.user, null);
    const bad = await t.api('POST', '/api/login', { login: 'admin', password: 'notright' });
    assert.equal(bad.status, 401);
    await t.login('admin', 'admin123');
    const me = await t.api('GET', '/api/me');
    assert.equal(me.status, 200);
    assert.equal((me.json.user as { role: string }).role, 'admin');
    assert.equal((me.json.user as { pass_hash?: string }).pass_hash, undefined);
  });

  test('csrf: begona sayt so\'rovi rad etiladi', async () => {
    const r = await t.api('POST', '/api/projects', { name: 'x' }, undefined, { 'sec-fetch-site': 'cross-site' });
    assert.equal(r.status, 403);
  });

  test('loyiha: standart ish papkasi va yangi loyiha', async () => {
    const list = await t.api('GET', '/api/projects');
    const projects = list.json.projects as Array<{ kind: string; path: string }>;
    assert.equal(projects.length, 1);
    assert.equal(projects[0].kind, 'workspace');
    assert.ok(fs.existsSync(projects[0].path));
    const created = await t.api('POST', '/api/projects', { name: 'Hisobotlar 2026' });
    assert.equal(created.status, 200);
    const p = created.json.project as { id: string; path: string };
    assert.ok(p.path.endsWith('hisobotlar-2026'));
    const outside = await t.api('GET', `/api/projects/${p.id}/files?path=../../`);
    assert.equal(outside.status, 400);
    const empty = await t.api('GET', `/api/projects/${p.id}/files`);
    assert.deepEqual(empty.json.entries, []);
  });

  test('fayl yuklash va yuklab olish', async () => {
    const list = await t.api('GET', '/api/projects');
    const p = (list.json.projects as Array<{ id: string }>)[0];
    const up = await t.api('PUT', `/api/projects/${p.id}/upload?name=${encodeURIComponent('../hujjat.txt')}`, undefined, Buffer.from('salom'));
    assert.equal(up.status, 200);
    const att = up.json.attachment as { path: string; name: string };
    assert.equal(att.path, 'uploads/hujjat.txt');
    const dl = await t.api('GET', `/api/projects/${p.id}/file?path=${encodeURIComponent(att.path)}`);
    assert.equal(dl.status, 200);
    assert.equal(dl.body.toString(), 'salom');
    const text = await t.api('GET', `/api/projects/${p.id}/text?path=${encodeURIComponent(att.path)}`);
    assert.equal(text.json.text, 'salom');
    const missing = await t.api('GET', `/api/projects/${p.id}/file?path=yoq.txt`);
    assert.equal(missing.status, 404);
  });

  test('suhbat: oqim, javob, narx', async () => {
    const created = await t.api('POST', '/api/sessions', { model: 'sonnet', mode: 'auto' });
    assert.equal(created.status, 200);
    const s = created.json.session as SessionInfo;
    const ws = await t.ws();
    ws.send({ a: 'subscribe', session_id: s.id });
    await ws.wait((e) => e.t === 'history');
    ws.send({ a: 'send', session_id: s.id, text: 'Qalaysan' });
    await ws.wait((e) => e.t === 'result');
    const streams = ws.of('stream');
    assert.ok(streams.length > 3, 'oqim hodisalari kelishi kerak');
    const assistant = ws.of('assistant');
    assert.equal((assistant[0].blocks[0] as { text: string }).text, 'Salom! Qalaysan');
    const result = ws.of('result')[0];
    assert.equal(result.cost_delta, 0.01);
    const st = await ws.wait((e) => e.t === 'state' && e.state === 'idle');
    assert.ok(st);
    const info = await t.api('GET', `/api/sessions/${s.id}`);
    const hist = info.json.history as ChatEvent[];
    assert.deepEqual(
      hist.map((h) => h.t),
      ['user', 'init', 'assistant', 'result'],
    );
    assert.equal((info.json.session as SessionInfo).title, 'Qalaysan');
    assert.equal((info.json.session as SessionInfo).cost_usd, 0.01);
    ws.send({ a: 'send', session_id: s.id, text: 'Yana' });
    await ws.wait((e) => e.t === 'result' && e.cost_total > 0.015);
    const info2 = await t.api('GET', `/api/sessions/${s.id}`);
    assert.equal((info2.json.session as SessionInfo).cost_usd, 0.02);
    assert.equal((info2.json.session as SessionInfo).turns, 2);
    const usage = await t.api('GET', '/api/usage');
    assert.ok((usage.json.total as number) >= 0.02);
    ws.close();
  });

  test('ruxsat so\'rovi: rad etish va doim ruxsat', async () => {
    const created = await t.api('POST', '/api/sessions', { mode: 'default' });
    const s = created.json.session as SessionInfo;
    const ws = await t.ws();
    ws.send({ a: 'subscribe', session_id: s.id });
    await ws.wait((e) => e.t === 'history');
    ws.send({ a: 'send', session_id: s.id, text: 'vosita ishlat' });
    const req = await ws.wait((e) => e.t === 'permission_request');
    const pr = req.ev as Extract<ChatEvent, { t: 'permission_request' }>;
    assert.equal(pr.tool, 'Bash');
    await ws.wait((e) => e.t === 'state' && e.state === 'requires_action');
    // boshqa ulanish ham kutilayotgan so'rovni ko'radi
    const ws2 = await t.ws();
    ws2.send({ a: 'subscribe', session_id: s.id });
    const h = await ws2.wait((e) => e.t === 'history');
    assert.equal((h.ev as { pending: ChatEvent[] }).pending.length, 1);
    ws2.close();
    ws.send({ a: 'permission', session_id: s.id, request_id: pr.request_id, behavior: 'deny', message: 'kerak emas' });
    await ws.wait((e) => e.t === 'result');
    const tr = ws.of('tool_result')[0];
    assert.equal(tr.is_error, true);
    // doim ruxsat → ikkinchi so'rovda so'ralmaydi
    ws.send({ a: 'send', session_id: s.id, text: 'vosita ishlat' });
    const req2 = await ws.wait((e) => e.t === 'permission_request' && e.request_id !== pr.request_id);
    ws.send({ a: 'permission', session_id: s.id, request_id: (req2.ev as { request_id: string }).request_id, behavior: 'allow', always: true });
    await ws.wait((e) => e.t === 'result' && e.cost_total > 0.015);
    ws.send({ a: 'send', session_id: s.id, text: 'vosita ishlat' });
    await ws.wait((e) => e.t === 'result' && e.cost_total > 0.025);
    assert.equal(ws.of('permission_request').length, 2, 'uchinchi marta so\'ralmasligi kerak');
    ws.close();
  });

  test('AskUserQuestion javobi va reja (todos)', async () => {
    const created = await t.api('POST', '/api/sessions', {});
    const s = created.json.session as SessionInfo;
    const ws = await t.ws();
    ws.send({ a: 'subscribe', session_id: s.id });
    await ws.wait((e) => e.t === 'history');
    ws.send({ a: 'send', session_id: s.id, text: 'savol ber' });
    const req = await ws.wait((e) => e.t === 'permission_request');
    const pr = req.ev as Extract<ChatEvent, { t: 'permission_request' }>;
    assert.equal(pr.tool, 'AskUserQuestion');
    ws.send({ a: 'permission', session_id: s.id, request_id: pr.request_id, behavior: 'allow', updated_input: { questions: (pr.input as { questions: unknown }).questions, answers: { 'Qaysi format?': 'PDF' } } });
    await ws.wait((e) => e.t === 'result');
    const last = ws.of('assistant').at(-1)!;
    assert.match((last.blocks[0] as { text: string }).text, /PDF/);
    ws.send({ a: 'send', session_id: s.id, text: 'reja tuz' });
    const todos = await ws.wait((e) => e.t === 'todos');
    assert.equal((todos.ev as { items: unknown[] }).items.length, 3);
    await ws.wait((e) => e.t === 'result' && e.cost_total > 0.015);
    const info = await t.api('GET', `/api/sessions/${s.id}`);
    assert.equal((info.json.todos as unknown[]).length, 3);
    ws.close();
  });

  test('yaratilgan fayl natijalarga tushadi', async () => {
    const created = await t.api('POST', '/api/sessions', {});
    const s = created.json.session as SessionInfo;
    const ws = await t.ws();
    ws.send({ a: 'subscribe', session_id: s.id });
    await ws.wait((e) => e.t === 'history');
    ws.send({ a: 'send', session_id: s.id, text: 'hisobot yoz' });
    const files = await ws.wait((e) => e.t === 'files');
    const list = (files.ev as { files: Array<{ path: string; kind: string }> }).files;
    assert.equal(list[0].path, 'hisobot.md');
    const info = await t.api('GET', `/api/sessions/${s.id}`);
    assert.equal((info.json.session as SessionInfo).files[0].name, 'hisobot.md');
    ws.close();
  });

  test('API xatosi tizim xabari sifatida ko\'rinadi', async () => {
    const created = await t.api('POST', '/api/sessions', {});
    const s = created.json.session as SessionInfo;
    const ws = await t.ws();
    ws.send({ a: 'subscribe', session_id: s.id });
    await ws.wait((e) => e.t === 'history');
    ws.send({ a: 'send', session_id: s.id, text: 'xato chiqar' });
    const sys = await ws.wait((e) => e.t === 'system' && e.kind === 'error');
    assert.match((sys.ev as { text: string }).text, /kalit/);
    ws.close();
  });

  test('rejim va model o\'zgartirish; bypass faqat admin', async () => {
    const created = await t.api('POST', '/api/sessions', {});
    const s = created.json.session as SessionInfo;
    const ws = await t.ws();
    ws.send({ a: 'subscribe', session_id: s.id });
    await ws.wait((e) => e.t === 'history');
    ws.send({ a: 'set_mode', session_id: s.id, mode: 'plan' });
    await ws.wait((e) => e.t === 'state' && e.permissionMode === 'plan');
    ws.send({ a: 'set_model', session_id: s.id, model: 'opus' });
    await ws.wait((e) => e.t === 'state' && e.model === 'opus');
    const info = await t.api('GET', `/api/sessions/${s.id}`);
    assert.equal((info.json.session as SessionInfo).mode, 'plan');
    assert.equal((info.json.session as SessionInfo).model, 'opus');
    ws.close();
  });

  test('agent muhiti: kalit va maxfiy o\'zgaruvchilar subprotsessga o\'tmaydi', async () => {
    process.env.SUPER_SECRET_TOKEN = 'x';
    const created = await t.api('POST', '/api/sessions', {});
    const s = created.json.session as SessionInfo;
    const ws = await t.ws();
    ws.send({ a: 'subscribe', session_id: s.id });
    await ws.wait((e) => e.t === 'history');
    ws.send({ a: 'send', session_id: s.id, text: 'salom' });
    await ws.wait((e) => e.t === 'result');
    const start = t.engine.starts.at(-1)!;
    assert.equal(start.env.SUPER_SECRET_TOKEN, undefined);
    assert.ok(start.env.CLAUDE_CONFIG_DIR?.includes(path.join('users')));
    assert.ok(start.disallowedTools?.includes('Artifact'));
    assert.match(start.systemPromptAppend ?? '', /o'zbek/i);
    ws.close();
    delete process.env.SUPER_SECRET_TOKEN;
  });

  test('admin: foydalanuvchi yaratish, a\'zo huquqlari', async () => {
    const r = await t.api('POST', '/api/admin/users', { login: 'Ali', name: 'Ali', password: 'ali12345', monthly_limit_usd: 5 });
    assert.equal(r.status, 200);
    const dup = await t.api('POST', '/api/admin/users', { login: 'ali', name: 'Ali', password: 'ali12345' });
    assert.equal(dup.status, 409);
    const adminCookie = t.cookie;
    t.cookie = '';
    await t.login('ali', 'ali12345');
    const me = await t.api('GET', '/api/me');
    assert.equal((me.json.user as { must_change_password: boolean }).must_change_password, true);
    const adminOnly = await t.api('GET', '/api/admin/users');
    assert.equal(adminOnly.status, 403);
    const ext = await t.api('POST', '/api/projects', { name: 'Tashqi', path: '/tmp' });
    assert.equal(ext.status, 403);
    const mine = await t.api('GET', '/api/sessions');
    assert.equal((mine.json.sessions as unknown[]).length, 0);
    // bypass rejimi a'zo uchun auto ga tushadi
    const created = await t.api('POST', '/api/sessions', { mode: 'bypassPermissions' });
    assert.equal((created.json.session as SessionInfo).mode, 'auto');
    // boshqa foydalanuvchining sessiyasini ko'ra olmaydi
    t.cookie = adminCookie;
    const adminSessions = await t.api('GET', '/api/sessions');
    const sid = (adminSessions.json.sessions as SessionInfo[])[0].id;
    t.cookie = '';
    await t.login('ali', 'ali12345');
    const forbidden = await t.api('GET', `/api/sessions/${sid}`);
    assert.equal(forbidden.status, 404);
    t.cookie = adminCookie;
  });

  test('agentlar: yaratish, nom tekshiruvi, subprotsessga uzatish', async () => {
    const bad = await t.api('POST', '/api/agents', { name: 'Hisobchi!', prompt: 'x' });
    assert.equal(bad.status, 400);
    const ok = await t.api('POST', '/api/agents', { name: 'hisobchi', title: 'Hisobchi', description: 'Moliyaviy hisobotlar', prompt: 'Sen buxgaltersan.', tools: ['Read', 'Bash'], user_id: null });
    assert.equal(ok.status, 200);
    const created = await t.api('POST', '/api/sessions', { agent: 'hisobchi' });
    const s = created.json.session as SessionInfo;
    const ws = await t.ws();
    ws.send({ a: 'subscribe', session_id: s.id });
    await ws.wait((e) => e.t === 'history');
    ws.send({ a: 'send', session_id: s.id, text: 'salom' });
    await ws.wait((e) => e.t === 'result');
    const start = t.engine.starts.at(-1)!;
    assert.equal(start.agent, 'hisobchi');
    assert.equal(start.agents?.hisobchi.prompt, 'Sen buxgaltersan.');
    ws.close();
  });

  test('rejali vazifa: yaratish va keyingi vaqt', async () => {
    const r = await t.api('POST', '/api/schedules', { title: 'Kunlik', prompt: 'Hisobot tayyorla', spec: { kind: 'daily', time: '09:00' } });
    assert.equal(r.status, 200);
    const sch = r.json.schedule as { next_run: number; mode: string };
    assert.ok(sch.next_run > Date.now());
    assert.equal(sch.mode, 'acceptEdits');
    const bad = await t.api('POST', '/api/schedules', { title: 'x', prompt: 'y', spec: { kind: 'hourly' } });
    assert.equal(bad.status, 400);
  });

  test('sessiyani yopish va o\'chirish', async () => {
    const created = await t.api('POST', '/api/sessions', {});
    const s = created.json.session as SessionInfo;
    const ws = await t.ws();
    ws.send({ a: 'subscribe', session_id: s.id });
    await ws.wait((e) => e.t === 'history');
    ws.send({ a: 'send', session_id: s.id, text: 'salom' });
    await ws.wait((e) => e.t === 'result');
    assert.ok(t.app.service.runners.get(s.id)?.active);
    const closed = await t.api('POST', `/api/sessions/${s.id}/close`);
    assert.equal(closed.status, 200);
    assert.equal(t.app.service.runners.get(s.id), undefined);
    const del = await t.api('DELETE', `/api/sessions/${s.id}`);
    assert.equal(del.status, 200);
    const list = await t.api('GET', '/api/sessions');
    assert.ok(!(list.json.sessions as SessionInfo[]).some((x) => x.id === s.id));
    ws.close();
  });
});
