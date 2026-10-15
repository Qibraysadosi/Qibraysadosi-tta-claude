// Server kirish nuqtasi: `node dist/server/main.js` (.env o'qiladi).
import path from 'node:path';
import { loadDotEnv } from './config.js';
import { createApp } from './app.js';

loadDotEnv(path.resolve('.env'));

const app = await createApp();

let closing = false;
const shutdown = (sig: string): void => {
  if (closing) return;
  closing = true;
  console.log(`[main] ${sig} — to'xtatilmoqda`);
  const t = setTimeout(() => process.exit(0), 8000);
  app
    .close()
    .catch((e) => console.error('[main] yopishda xato', e))
    .finally(() => {
      clearTimeout(t);
      process.exit(0);
    });
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (e) => console.error('[main] uncaughtException', e));
process.on('unhandledRejection', (e) => console.error('[main] unhandledRejection', e));
