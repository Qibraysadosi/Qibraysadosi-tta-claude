// Soxta dvigatel bilan serverni ko'tarish (UI sinovi uchun): node scripts/serve-fake.mjs [port]
import { createApp } from '../dist/server/app.js';
import { FakeEngine } from '../dist/tests/fake-engine.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.argv[2] ?? 8097);
const dataDir = process.env.DATA_DIR ?? fs.mkdtempSync(path.join(os.tmpdir(), 'tta-fake-'));
const app = await createApp({
  config: { dataDir, port, host: '127.0.0.1', adminPassword: 'admin123', apiKey: 'sk-ant-fake-key-0000000000000000000000', hideApiKey: false },
  engine: new FakeEngine(),
  scheduler: false,
});
console.log('FAKE SERVER', app.url, 'login: admin / admin123');
process.on('SIGTERM', () => app.close().then(() => process.exit(0)));
