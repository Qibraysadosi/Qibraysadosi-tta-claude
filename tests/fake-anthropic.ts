// Soxta Anthropic API (SSE): haqiqiy Claude Code binari bilan integratsiya sinovi uchun.
// Birinchi so'rovga Bash vositasini chaqiradi, tool_result kelganda matn qaytaradi.
import http from 'node:http';

export interface FakeApi {
  url: string;
  requests: Array<{ path: string; body: Record<string, unknown>; headers: http.IncomingHttpHeaders }>;
  close(): void;
}

function sse(res: http.ServerResponse, events: Array<Record<string, unknown>>): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_fake' });
  for (const ev of events) res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
  res.end();
}

export function startFakeAnthropic(): Promise<FakeApi> {
  const requests: FakeApi['requests'] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
      } catch {
        /* */
      }
      requests.push({ path: req.url ?? '', body, headers: req.headers });
      if (!(req.url ?? '').startsWith('/v1/messages') || req.method !== 'POST') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fake: ' + req.url } }));
        return;
      }
      if ((req.url ?? '').includes('count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 42 }));
        return;
      }
      const messages = (body.messages ?? []) as Array<{ role: string; content: unknown }>;
      const last = [...messages].reverse().find((m) => m.role === 'user');
      const lastText = JSON.stringify(last?.content ?? '');
      const model = String(body.model ?? 'claude-fake');
      const usage = { input_tokens: 120, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 1 };
      const hasToolResult = lastText.includes('"tool_result"');
      const wantsTool = /vosita/.test(lastText) && !hasToolResult;
      const id = 'msg_' + Math.random().toString(36).slice(2, 8);
      // "reja" ssenariysi: TaskCreate → TaskUpdate → matn (vazifa vositalari bilan jarayon paneli sinovi)
      const rejaIdx = messages.map((m) => (m.role === 'user' && /reja tuz/.test(JSON.stringify(m.content)) ? 1 : 0)).lastIndexOf(1);
      if (rejaIdx >= 0) {
        const after = messages.slice(rejaIdx + 1).filter((m) => m.role === 'assistant').length;
        const toolUse = (name: string, input: Record<string, unknown>, tid: string): void =>
          sse(res, [
            { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } },
            { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: tid, name, input: {} } },
            { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } },
            { type: 'message_stop' },
          ]);
        if (after === 0) {
          toolUse('TaskCreate', { subject: 'Birinchi qadam', description: 'Sinov', activeForm: 'Birinchi qadam bajarilmoqda' }, 'toolu_task1');
          return;
        }
        if (after === 1) {
          const m = /#(\d+)/.exec(lastText);
          toolUse('TaskUpdate', { taskId: m ? m[1] : '1', status: 'completed' }, 'toolu_task2');
          return;
        }
      }
      if (wantsTool) {
        const input = JSON.stringify({ command: 'touch salom.txt && echo salom', description: 'Fayl yaratish' });
        sse(res, [
          { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Buyruqni bajaraman.' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_fake1', name: 'Bash', input: {} } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: input } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } },
          { type: 'message_stop' },
        ]);
        return;
      }
      const text = hasToolResult ? 'Natija: salom' : 'Salom! Men soxta API orqali javob beryapman.';
      sse(res, [
        { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        ...text.split(' ').map((w, i) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: (i ? ' ' : '') + w } })),
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } },
        { type: 'message_stop' },
      ]);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => server.close() });
    });
  });
}
