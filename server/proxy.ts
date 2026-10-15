// Kalit himoyasi: agent subprotsessi haqiqiy API kalitni ko'rmaydi.
// Subprotsessga ANTHROPIC_BASE_URL=http://127.0.0.1:<port> va soxta ANTHROPIC_API_KEY beriladi;
// bu proksi so'rovni api.anthropic.com ga haqiqiy kalit bilan uzatadi (oqimli javoblar ham).
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { URL } from 'node:url';

export interface KeyProxy {
  port: number;
  localKey: string;
  baseUrl: string;
  setRealKey(key: string): void;
  close(): void;
}

const HOP_HEADERS = new Set(['host', 'connection', 'keep-alive', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

export async function startKeyProxy(upstream: string, realKey: string): Promise<KeyProxy> {
  const up = new URL(upstream);
  const localKey = 'tta-local-' + crypto.randomBytes(24).toString('hex');
  let currentKey = realKey;
  const agent = up.protocol === 'https:' ? new https.Agent({ keepAlive: true, maxSockets: 32 }) : new http.Agent({ keepAlive: true, maxSockets: 32 });
  const requester = up.protocol === 'https:' ? https.request : http.request;

  const server = http.createServer((req, res) => {
    const given = (req.headers['x-api-key'] as string | undefined) ?? '';
    const auth = (req.headers['authorization'] as string | undefined) ?? '';
    const authorized = given === localKey || auth === `Bearer ${localKey}`;
    if (!authorized) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'local proxy: invalid key' } }));
      return;
    }
    if (!currentKey) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'API kalit o\'rnatilmagan' } }));
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP_HEADERS.has(k)) continue;
      headers[k] = v;
    }
    if (given === localKey) headers['x-api-key'] = currentKey;
    if (auth === `Bearer ${localKey}`) headers['authorization'] = `Bearer ${currentKey}`;
    headers['host'] = up.host;
    const basePath = up.pathname.replace(/\/$/, '');
    const upstreamReq = requester(
      {
        protocol: up.protocol,
        hostname: up.hostname,
        port: up.port || (up.protocol === 'https:' ? 443 : 80),
        method: req.method,
        path: basePath + (req.url ?? '/'),
        headers,
        agent,
      },
      (upRes) => {
        const outHeaders: Record<string, string | string[]> = {};
        for (const [k, v] of Object.entries(upRes.headers)) {
          if (v === undefined || HOP_HEADERS.has(k)) continue;
          outHeaders[k] = v;
        }
        res.writeHead(upRes.statusCode ?? 502, outHeaders);
        upRes.pipe(res);
        upRes.on('error', () => res.destroy());
      },
    );
    upstreamReq.setTimeout(10 * 60_000, () => upstreamReq.destroy(new Error('upstream timeout')));
    upstreamReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'proxy: ' + err.message } }));
      } else res.destroy();
    });
    req.pipe(upstreamReq);
    req.on('aborted', () => upstreamReq.destroy());
  });
  server.keepAliveTimeout = 65_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  return {
    port,
    localKey,
    baseUrl: `http://127.0.0.1:${port}`,
    setRealKey(key: string) {
      currentKey = key;
    },
    close() {
      server.close();
      agent.destroy();
    },
  };
}
