import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startKeyProxy } from '../server/proxy.js';
import { computeNextRun, zonedToEpoch } from '../server/scheduler.js';
import { hashPassword, verifyPassword, makeToken, parseToken } from '../server/auth.js';
import { safeResolve, safeName } from '../server/files.js';

describe('kalit proksisi', () => {
  test('soxta kalitni haqiqiysiga almashtiradi, boshqa kalitni rad etadi, oqimni uzatadi', async () => {
    let seenKey = '';
    const upstream = http.createServer((req, res) => {
      seenKey = String(req.headers['x-api-key'] ?? '');
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: ping\ndata: {}\n\n');
      setTimeout(() => res.end('data: done\n\n'), 20);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    const port = (upstream.address() as { port: number }).port;
    const proxy = await startKeyProxy(`http://127.0.0.1:${port}`, 'sk-ant-real');
    const call = (key: string): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = http.request(`${proxy.baseUrl}/v1/messages`, { method: 'POST', headers: { 'x-api-key': key, 'content-type': 'application/json' } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        });
        req.on('error', reject);
        req.end('{}');
      });
    const ok = await call(proxy.localKey);
    assert.equal(ok.status, 200);
    assert.equal(seenKey, 'sk-ant-real');
    assert.match(ok.body, /done/);
    const bad = await call('sk-ant-other');
    assert.equal(bad.status, 401);
    proxy.setRealKey('sk-ant-new');
    await call(proxy.localKey);
    assert.equal(seenKey, 'sk-ant-new');
    proxy.close();
    upstream.close();
  });
});

describe('rejalashtiruvchi', () => {
  const tz = 'Asia/Tashkent';
  test('kunlik: bugun o\'tgan bo\'lsa ertaga', () => {
    const now = zonedToEpoch(2026, 10, 16, 10, 0, tz);
    const next = computeNextRun({ kind: 'daily', time: '09:00' }, now, tz)!;
    assert.equal(next, zonedToEpoch(2026, 10, 17, 9, 0, tz));
    const next2 = computeNextRun({ kind: 'daily', time: '18:30' }, now, tz)!;
    assert.equal(next2, zonedToEpoch(2026, 10, 16, 18, 30, tz));
  });
  test('haftalik: faqat tanlangan kunlar', () => {
    const now = zonedToEpoch(2026, 10, 16, 10, 0, tz); // juma
    const next = computeNextRun({ kind: 'weekly', days: [1], time: '08:00' }, now, tz)!; // dushanba
    assert.equal(next, zonedToEpoch(2026, 10, 19, 8, 0, tz));
  });
  test('interval va bir martalik', () => {
    const now = Date.now();
    assert.equal(computeNextRun({ kind: 'interval', minutes: 60 }, now, tz), now + 3600_000);
    assert.equal(computeNextRun({ kind: 'once', at: now - 1 }, now, tz), null);
    assert.equal(computeNextRun({ kind: 'once', at: now + 5 }, now, tz), now + 5);
  });
  test('zona: Toshkent UTC+5', () => {
    assert.equal(zonedToEpoch(2026, 1, 1, 5, 0, tz), Date.UTC(2026, 0, 1, 0, 0));
  });
});

describe('auth va fayllar', () => {
  test('parol xeshi', () => {
    const h = hashPassword('sirli123');
    assert.ok(verifyPassword('sirli123', h));
    assert.ok(!verifyPassword('sirli124', h));
    assert.ok(!verifyPassword('x', 'buzuq'));
  });
  test('token', () => {
    const tok = makeToken('s', 'u1', 1000);
    assert.equal(parseToken('s', tok)?.uid, 'u1');
    assert.equal(parseToken('boshqa', tok), null);
    assert.equal(parseToken('s', makeToken('s', 'u1', -1)), null);
  });
  test('xavfsiz yo\'l', () => {
    assert.throws(() => safeResolve('/tmp/root', '../etc/passwd'));
    assert.throws(() => safeResolve('/tmp/root', 'a/../../x'));
    assert.equal(safeResolve('/tmp/root', 'a/b.txt'), '/tmp/root/a/b.txt');
    assert.equal(safeResolve('/tmp/root', '/a/b.txt'), '/tmp/root/a/b.txt');
    assert.equal(safeName('../../x<y>.txt'), 'x_y_.txt');
  });
});
