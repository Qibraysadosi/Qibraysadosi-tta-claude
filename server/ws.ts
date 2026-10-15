// WebSocket: sessiya hodisalarini jonli uzatish va foydalanuvchi harakatlarini qabul qilish.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { Service } from './service.js';
import { ServiceError } from './service.js';
import type { UserRecord } from './store.js';
import type { ClientMessage, LiveEvent, ServerEnvelope } from '../shared/protocol.js';

export function createWsServer(service: Service, authenticate: (req: IncomingMessage) => UserRecord | null, basePath: string): { handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean; close: () => void } {
  const wss = new WebSocketServer({ noServer: true });
  const wsPath = basePath + '/ws';

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const user = authenticate(req);
    if (!user) {
      ws.close(4401, 'unauthorized');
      return;
    }
    const subs = new Map<string, () => void>();
    const send = (sessionId: string | undefined, ev: LiveEvent): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const env: ServerEnvelope = { session_id: sessionId, ev };
      ws.send(JSON.stringify(env));
    };
    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, 30_000);

    ws.on('message', (raw) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(raw)) as ClientMessage;
      } catch {
        send(undefined, { t: 'error', code: 'bad_json', message: 'JSON noto\'g\'ri' });
        return;
      }
      void handle(msg).catch((e: unknown) => {
        const sid = 'session_id' in msg ? msg.session_id : undefined;
        if (e instanceof ServiceError) send(sid, { t: 'error', code: e.code, message: e.message });
        else {
          service.log('[ws] xato', e);
          send(sid, { t: 'error', code: 'internal', message: String((e as Error)?.message ?? e) });
        }
      });
    });

    async function handle(msg: ClientMessage): Promise<void> {
      switch (msg.a) {
        case 'ping':
          return;
        case 'subscribe': {
          const sid = msg.session_id;
          if (subs.has(sid)) return;
          const runner = service.runnerFor(user!, sid);
          const unsub = service.subscribe(sid, (ev) => send(sid, ev));
          subs.set(sid, unsub);
          send(sid, { t: 'session', session: runner.session });
          send(sid, { t: 'history', events: runner.history(), pending: runner.pendingEvents() });
          send(sid, { t: 'state', state: runner.state, permissionMode: runner.session.mode, model: runner.session.model });
          if (runner.todos.length) send(sid, { t: 'todos', items: runner.todos, ts: Date.now() });
          return;
        }
        case 'unsubscribe': {
          subs.get(msg.session_id)?.();
          subs.delete(msg.session_id);
          return;
        }
        case 'send': {
          if (!service.config.apiKey) throw new ServiceError(400, 'no_api_key', 'API kalit o\'rnatilmagan');
          const runner = service.runnerFor(user!, msg.session_id);
          if (runner.session.user_id !== user!.id) throw new ServiceError(403, 'forbidden');
          const text = String(msg.text ?? '').slice(0, 60_000);
          const attachments = Array.isArray(msg.attachments) ? msg.attachments.slice(0, 20) : [];
          if (!text.trim() && !attachments.length) return;
          await runner.send(text, attachments, user!.id);
          return;
        }
        case 'interrupt': {
          const runner = service.runners.get(msg.session_id);
          if (runner && runner.session.user_id === user!.id) await runner.interrupt();
          return;
        }
        case 'permission': {
          const runner = service.runners.get(msg.session_id);
          if (!runner || runner.session.user_id !== user!.id) throw new ServiceError(404, 'session_not_found');
          const ok = runner.answerPermission(msg.request_id, msg.behavior, { always: msg.always, message: msg.message, updatedInput: msg.updated_input, by: user!.id });
          if (!ok) send(msg.session_id, { t: 'error', code: 'no_pending', message: 'Bu so\'rov allaqachon yopilgan' });
          return;
        }
        case 'set_mode': {
          const runner = service.runnerFor(user!, msg.session_id);
          if (runner.session.user_id !== user!.id) throw new ServiceError(403, 'forbidden');
          await runner.setMode(service.validMode(user!, msg.mode));
          return;
        }
        case 'set_model': {
          const runner = service.runnerFor(user!, msg.session_id);
          if (runner.session.user_id !== user!.id) throw new ServiceError(403, 'forbidden');
          await runner.setModel(service.validModel(msg.model));
          return;
        }
        default:
          send(undefined, { t: 'error', code: 'unknown_action', message: 'Noma\'lum harakat' });
      }
    }

    ws.on('close', () => {
      clearInterval(ping);
      for (const unsub of subs.values()) unsub();
      subs.clear();
    });
  });

  return {
    handleUpgrade(req, socket, head) {
      const url = new URL(req.url ?? '/', 'http://local');
      if (url.pathname !== wsPath && url.pathname !== wsPath + '/') return false;
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
      return true;
    },
    close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
    },
  };
}
