// Soxta dvigatel: SDK xabarlarini ssenariy bo'yicha chiqaradi (API kalitsiz test).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Engine, EngineHandle, EngineStartOptions, SDKMessage, SDKUserMessage } from '../server/engine.js';
import { InputQueue } from '../server/engine.js';

class OutQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;
  push(v: T): void {
    const w = this.waiters.shift();
    if (w) w({ value: v, done: false });
    else this.items.push(v);
  }
  end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const it = this.items.shift();
        if (it !== undefined) return Promise.resolve({ value: it, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

export class FakeEngine implements Engine {
  public starts: EngineStartOptions[] = [];
  public cost = 0.01;
  start(opts: EngineStartOptions): EngineHandle {
    this.starts.push(opts);
    const input = new InputQueue();
    const out = new OutQueue<SDKMessage>();
    const sessionId = opts.resume ?? crypto.randomUUID();
    let total = 0;
    let mode = opts.permissionMode;
    let model = opts.model;
    let closed = false;
    const sys = (extra: Record<string, unknown>): SDKMessage => ({ type: 'system', uuid: crypto.randomUUID(), session_id: sessionId, ...extra }) as unknown as SDKMessage;
    const assistant = (content: unknown[], extra: Record<string, unknown> = {}): SDKMessage =>
      ({ type: 'assistant', uuid: crypto.randomUUID(), session_id: sessionId, message: { id: 'msg_' + crypto.randomBytes(3).toString('hex'), role: 'assistant', model, content, stop_reason: 'end_turn', usage: {} }, parent_tool_use_id: null, ...extra }) as unknown as SDKMessage;
    const userToolResult = (toolUseId: string, content: string, structured?: unknown, isError = false): SDKMessage =>
      ({ type: 'user', uuid: crypto.randomUUID(), session_id: sessionId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError }] }, parent_tool_use_id: null, tool_use_result: structured }) as unknown as SDKMessage;
    const result = (isError = false, subtype = 'success', text = 'ok'): SDKMessage => {
      total += this.cost;
      return {
        type: 'result',
        subtype,
        uuid: crypto.randomUUID(),
        session_id: sessionId,
        duration_ms: 120,
        duration_api_ms: 100,
        is_error: isError,
        num_turns: 1,
        result: text,
        stop_reason: 'end_turn',
        total_cost_usd: total,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        modelUsage: { [model]: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: this.cost, contextWindow: 200000, maxOutputTokens: 32000 } },
        permission_denials: [],
        errors: [],
        queued_turn_count: 0,
      } as unknown as SDKMessage;
    };
    const streamText = (text: string): void => {
      out.push({ type: 'stream_event', uuid: crypto.randomUUID(), session_id: sessionId, parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm', role: 'assistant', content: [], model } } } as unknown as SDKMessage);
      out.push({ type: 'stream_event', uuid: crypto.randomUUID(), session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } } as unknown as SDKMessage);
      for (const piece of text.match(/.{1,6}/g) ?? []) {
        out.push({ type: 'stream_event', uuid: crypto.randomUUID(), session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: piece } } } as unknown as SDKMessage);
      }
      out.push({ type: 'stream_event', uuid: crypto.randomUUID(), session_id: sessionId, parent_tool_use_id: null, event: { type: 'content_block_stop', index: 0 } } as unknown as SDKMessage);
    };

    const run = async (): Promise<void> => {
      let first = true;
      for await (const msg of input) {
        if (closed) break;
        if (first) {
          out.push(sys({ subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', cwd: opts.cwd, tools: ['Read', 'Write', 'Bash', 'TodoWrite'], mcp_servers: [], model, permissionMode: mode, slash_commands: [], output_style: 'default', skills: [], plugins: [], claude_code_version: '0.0.0-fake', agents: Object.keys(opts.agents ?? {}) }));
          first = false;
        }
        const text = extractText(msg);
        out.push(sys({ subtype: 'session_state_changed', state: 'running' }));
        if (text.includes('xato')) {
          out.push(assistant([{ type: 'text', text: 'API error' }], { error: 'authentication_failed' }));
          out.push(result(true, 'success', 'authentication failed'));
        } else if (text.includes('vosita')) {
          const id = 'toolu_' + crypto.randomBytes(4).toString('hex');
          out.push(assistant([{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls -la', description: 'Ro\'yxat' } }]));
          const decision = await opts.canUseTool('Bash', { command: 'ls -la', description: 'Ro\'yxat' }, { signal: opts.abortController.signal, toolUseID: id, requestId: 'req_' + id, suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }], behavior: 'allow', destination: 'session' }] });
          if (decision && decision.behavior === 'allow') {
            out.push(userToolResult(id, 'total 0\n', { stdout: 'total 0', stderr: '', interrupted: false }));
            out.push(assistant([{ type: 'text', text: 'Papka bo\'sh.' }]));
          } else {
            out.push(userToolResult(id, 'Rad etildi', undefined, true));
            out.push(assistant([{ type: 'text', text: 'Buyruq rad etildi.' }]));
          }
          out.push(result());
        } else if (text.includes('savol')) {
          const id = 'toolu_' + crypto.randomBytes(4).toString('hex');
          const inputQ = { questions: [{ question: 'Qaysi format?', header: 'Format', options: [{ label: 'PDF', description: 'Hujjat' }, { label: 'DOCX', description: 'Word' }], multiSelect: false }] };
          out.push(assistant([{ type: 'tool_use', id, name: 'AskUserQuestion', input: inputQ }]));
          const decision = await opts.canUseTool('AskUserQuestion', inputQ, { signal: opts.abortController.signal, toolUseID: id, requestId: 'req_' + id });
          const answers = decision && decision.behavior === 'allow' ? (decision.updatedInput as { answers?: Record<string, string> })?.answers : undefined;
          out.push(userToolResult(id, JSON.stringify(answers ?? {})));
          out.push(assistant([{ type: 'text', text: 'Javob: ' + JSON.stringify(answers ?? null) }]));
          out.push(result());
        } else if (text.includes('yoz')) {
          const id = 'toolu_' + crypto.randomBytes(4).toString('hex');
          const file = path.join(opts.cwd, 'hisobot.md');
          out.push(assistant([{ type: 'tool_use', id, name: 'Write', input: { file_path: file, content: '# Hisobot\n' } }]));
          fs.writeFileSync(file, '# Hisobot\n');
          out.push(userToolResult(id, 'File written', { type: 'create', filePath: file }));
          out.push(assistant([{ type: 'text', text: 'Fayl yozildi: hisobot.md' }]));
          out.push(result());
        } else if (text.includes('reja')) {
          const id = 'toolu_' + crypto.randomBytes(4).toString('hex');
          out.push(assistant([{ type: 'tool_use', id, name: 'TodoWrite', input: { todos: [{ content: 'Birinchi', status: 'completed' }, { content: 'Ikkinchi', status: 'in_progress', activeForm: 'Ikkinchi bajarilmoqda' }, { content: 'Uchinchi', status: 'pending' }] } }]));
          out.push(userToolResult(id, 'ok'));
          streamText('Reja tuzildi.');
          out.push(assistant([{ type: 'text', text: 'Reja tuzildi.' }]));
          out.push(result());
        } else {
          streamText('Salom! ' + text);
          out.push(assistant([{ type: 'text', text: 'Salom! ' + text }]));
          out.push(result());
        }
        out.push(sys({ subtype: 'session_state_changed', state: 'idle' }));
      }
      out.end();
    };
    void run();

    return {
      messages: out,
      push: (m) => input.push(m),
      end: () => input.end(),
      interrupt: async () => {},
      setPermissionMode: async (m) => {
        mode = m;
      },
      setModel: async (m) => {
        model = m;
      },
      supportedModels: async () => [],
      close: () => {
        closed = true;
        input.end();
        out.end();
      },
    };
  }
}

function extractText(msg: SDKUserMessage): string {
  const c = msg.message.content;
  if (typeof c === 'string') return c;
  return (c as Array<{ type: string; text?: string }>)
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join(' ');
}
