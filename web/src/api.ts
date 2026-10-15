// REST va WebSocket mijoz.
import type { ClientMessage, LiveEvent, ServerEnvelope } from '../../shared/protocol';

declare global {
  interface Window {
    BASE_PATH?: string;
    desktop?: {
      pickFolder(): Promise<string | null>;
      reveal(path: string): Promise<void>;
      openPath(path: string): Promise<void>;
      openExternal(url: string): Promise<void>;
      version: string;
    };
  }
}

export const BASE = (window.BASE_PATH && window.BASE_PATH !== '__BASE_PATH__' ? window.BASE_PATH : '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, raw?: Blob | ArrayBuffer): Promise<T> {
  const headers: Record<string, string> = {};
  let payload: BodyInit | undefined;
  if (raw) payload = raw;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers, body: payload, credentials: 'same-origin' });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    /* JSON emas */
  }
  if (!res.ok) throw new ApiError(res.status, String(json.error ?? 'error'), String(json.message ?? json.error ?? res.statusText));
  return json as T;
}

export const api = {
  get: <T>(p: string) => call<T>('GET', p),
  post: <T>(p: string, b?: unknown) => call<T>('POST', p, b),
  patch: <T>(p: string, b?: unknown) => call<T>('PATCH', p, b),
  put: <T>(p: string, b?: unknown) => call<T>('PUT', p, b),
  del: <T>(p: string) => call<T>('DELETE', p),
  upload: <T>(p: string, blob: Blob) => call<T>('PUT', p, undefined, blob),
  fileUrl: (projectId: string, path: string, download = false) => `${BASE}/api/projects/${projectId}/file?path=${encodeURIComponent(path)}${download ? '&dl=1' : ''}`,
};

type Listener = (ev: LiveEvent, sessionId?: string) => void;

export class WsClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subs = new Set<string>();
  private retry = 0;
  private closedByUser = false;
  public connected = false;
  public onStatus: (connected: boolean) => void = () => {};

  connect(): void {
    this.closedByUser = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}${BASE}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retry = 0;
      this.onStatus(true);
      for (const sid of this.subs) this.send({ a: 'subscribe', session_id: sid });
    };
    ws.onmessage = (e) => {
      let env: ServerEnvelope;
      try {
        env = JSON.parse(String(e.data)) as ServerEnvelope;
      } catch {
        return;
      }
      for (const l of this.listeners) l(env.ev, env.session_id);
    };
    ws.onclose = () => {
      this.connected = false;
      this.onStatus(false);
      this.ws = null;
      if (this.closedByUser) return;
      const delay = Math.min(15000, 500 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }

  close(): void {
    this.closedByUser = true;
    this.ws?.close();
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  subscribe(sessionId: string): void {
    if (this.subs.has(sessionId)) return;
    this.subs.add(sessionId);
    this.send({ a: 'subscribe', session_id: sessionId });
  }

  unsubscribe(sessionId: string): void {
    if (!this.subs.delete(sessionId)) return;
    this.send({ a: 'unsubscribe', session_id: sessionId });
  }

  listen(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}
