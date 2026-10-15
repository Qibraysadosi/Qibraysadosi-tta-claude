// Agent dvigateli: Claude Agent SDK ustidan yupqa qatlam. Testlarda soxta dvigatel (tests/fake-engine.ts) ishlatiladi.
import type {
  AgentDefinition,
  CanUseTool,
  ModelInfo,
  PermissionMode as SdkPermissionMode,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

export type { SDKMessage, SDKUserMessage, CanUseTool, ModelInfo, AgentDefinition };

export interface EngineStartOptions {
  cwd: string;
  model: string;
  permissionMode: SdkPermissionMode;
  resume?: string;
  systemPromptAppend?: string;
  agents?: Record<string, AgentDefinition>;
  agent?: string;
  env: Record<string, string | undefined>;
  disallowedTools?: string[];
  allowedTools?: string[];
  canUseTool: CanUseTool;
  abortController: AbortController;
  additionalDirectories?: string[];
  maxBudgetUsd?: number;
  maxTurns?: number;
  claudeBinary?: string;
  permissionPrompts?: 'host' | 'none';
  allowDangerouslySkipPermissions?: boolean;
  stderr?: (data: string) => void;
}

export interface EngineHandle {
  /** SDK chiqish oqimi (assistant, user, result, stream_event, system ...). */
  messages: AsyncIterable<SDKMessage>;
  /** Yangi foydalanuvchi xabarini navbatga qo'yish. */
  push(msg: SDKUserMessage): void;
  /** Kirish oqimini yopish (subprotsess oxirgi navbatdan keyin tugaydi). */
  end(): void;
  interrupt(): Promise<void>;
  setPermissionMode(mode: SdkPermissionMode): Promise<void>;
  setModel(model: string): Promise<void>;
  supportedModels(): Promise<ModelInfo[]>;
  close(): void;
}

export interface Engine {
  start(opts: EngineStartOptions): EngineHandle;
}

/** Navbat → async generator: SDK `prompt` sifatida ishlatiladi (streaming-input rejimi). */
export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = [];
  private waiters: Array<(v: IteratorResult<SDKUserMessage>) => void> = [];
  private ended = false;
  push(msg: SDKUserMessage): void {
    if (this.ended) return;
    const w = this.waiters.shift();
    if (w) w({ value: msg, done: false });
    else this.items.push(msg);
  }
  end(): void {
    this.ended = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as unknown as SDKUserMessage, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const it = this.items.shift();
        if (it) return Promise.resolve({ value: it, done: false });
        if (this.ended) return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        this.ended = true;
        return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
      },
    };
  }
}

export class SdkEngine implements Engine {
  start(opts: EngineStartOptions): EngineHandle {
    const queue = new InputQueue();
    let q: Query | null = null;
    // SDK ni kech yuklaymiz (import og'ir) — faqat birinchi sessiyada.
    const started = (async () => {
      const sdk = await import('@anthropic-ai/claude-agent-sdk');
      const query = sdk.query({
        prompt: queue,
        options: {
          cwd: opts.cwd,
          model: opts.model,
          permissionMode: opts.permissionMode,
          allowDangerouslySkipPermissions: opts.allowDangerouslySkipPermissions ?? opts.permissionMode === 'bypassPermissions',
          resume: opts.resume,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.systemPromptAppend },
          agents: opts.agents,
          agent: opts.agent,
          env: opts.env,
          disallowedTools: opts.disallowedTools,
          allowedTools: opts.allowedTools,
          canUseTool: opts.canUseTool,
          abortController: opts.abortController,
          additionalDirectories: opts.additionalDirectories,
          maxBudgetUsd: opts.maxBudgetUsd,
          maxTurns: opts.maxTurns,
          pathToClaudeCodeExecutable: opts.claudeBinary || undefined,
          includePartialMessages: true,
          settingSources: ['user', 'project'],
          permissionPrompts: opts.permissionPrompts ?? 'host',
          stderr: opts.stderr,
          persistSession: true,
          agentProgressSummaries: true,
        },
      });
      q = query;
      return query;
    })();

    const messages: AsyncIterable<SDKMessage> = {
      [Symbol.asyncIterator]() {
        let inner: AsyncIterator<SDKMessage> | null = null;
        return {
          async next(): Promise<IteratorResult<SDKMessage>> {
            if (!inner) inner = (await started)[Symbol.asyncIterator]();
            return inner.next();
          },
          async return(): Promise<IteratorResult<SDKMessage>> {
            if (inner?.return) return inner.return();
            return { value: undefined, done: true };
          },
        };
      },
    };

    return {
      messages,
      push: (m) => queue.push(m),
      end: () => queue.end(),
      interrupt: async () => {
        const query = await started;
        await query.interrupt();
      },
      setPermissionMode: async (mode) => {
        const query = await started;
        await query.setPermissionMode(mode);
      },
      setModel: async (model) => {
        const query = await started;
        await query.setModel(model);
      },
      supportedModels: async () => {
        const query = await started;
        return query.supportedModels();
      },
      close: () => {
        queue.end();
        try {
          q?.close();
        } catch {
          /* allaqachon yopilgan */
        }
      },
    };
  }
}
