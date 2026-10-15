// Ilovani yig'ish: sozlama → proksi → xizmat → HTTP + WS → rejalashtiruvchi. Server va desktop shu funksiyani chaqiradi.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AppConfig } from './config.js';
import { Service } from './service.js';
import { SdkEngine, type Engine } from './engine.js';
import { startKeyProxy, type KeyProxy } from './proxy.js';
import { createHttpHandler } from './http.js';
import { createWsServer } from './ws.js';
import { Scheduler } from './scheduler.js';

export interface App {
  config: AppConfig;
  service: Service;
  server: http.Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

export interface CreateAppOptions {
  config?: Partial<AppConfig>;
  engine?: Engine;
  desktopToken?: string;
  staticDir?: string;
  log?: (msg: string, ...rest: unknown[]) => void;
  scheduler?: boolean;
}

export function defaultStaticDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // dist/server/app.js → ../../web/dist
  return path.resolve(here, '..', '..', 'web', 'dist');
}

export async function createApp(opts: CreateAppOptions = {}): Promise<App> {
  const config = loadConfig(opts.config);
  const log = opts.log ?? ((m: string, ...r: unknown[]) => console.log(new Date().toISOString(), m, ...r));
  let proxy: KeyProxy | null = null;
  if (config.hideApiKey) {
    proxy = await startKeyProxy(config.apiBaseUrl, config.apiKey);
    log(`[app] kalit proksisi 127.0.0.1:${proxy.port}`);
  }
  const engine = opts.engine ?? new SdkEngine();
  const service = new Service(config, engine, proxy, log);
  const staticDir = opts.staticDir ?? defaultStaticDir();
  const { handle, authenticate } = createHttpHandler({ service, staticDir, desktopToken: opts.desktopToken });
  const server = http.createServer(handle);
  const ws = createWsServer(service, authenticate, config.basePath);
  server.on('upgrade', (req, socket, head) => {
    if (!ws.handleUpgrade(req, socket as never, head)) socket.destroy();
  });
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.port;
  const url = `http://${config.host}:${port}${config.basePath}/`;
  let scheduler: Scheduler | null = null;
  if (opts.scheduler !== false) {
    scheduler = new Scheduler(service);
    service.scheduler = scheduler;
    scheduler.start();
  }
  log(`[app] ${config.appName} v${config.version} → ${url} (ma'lumotlar: ${config.dataDir})`);
  if (!config.apiKey) log('[app] DIQQAT: ANTHROPIC_API_KEY o\'rnatilmagan — admin sozlamalaridan kiriting.');
  return {
    config,
    service,
    server,
    port,
    url,
    async close() {
      scheduler?.stop();
      ws.close();
      await service.closeAll();
      proxy?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
