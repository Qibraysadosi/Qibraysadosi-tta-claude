// Electron asosiy jarayoni: lokal server + oyna. Server bilan bir xil kod (server/app.ts), desktop rejimida.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, nativeTheme } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp, type App } from '../server/app.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..', '..'); // dist/desktop → ildiz
let server: App | null = null;
let win: BrowserWindow | null = null;
const token = crypto.randomBytes(24).toString('hex');

function unpacked(p: string): string {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
}

function claudeBinaryPath(): string {
  const pkg = `claude-agent-sdk-${process.platform}-${process.arch}`;
  const bin = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const candidates = [path.join(appRoot, 'node_modules', '@anthropic-ai', pkg, bin), path.join(process.resourcesPath ?? '', 'app.asar.unpacked', 'node_modules', '@anthropic-ai', pkg, bin)];
  for (const c of candidates) {
    const real = unpacked(c);
    if (fs.existsSync(real)) return real;
  }
  return '';
}

async function startServer(): Promise<App> {
  const dataDir = path.join(app.getPath('userData'), 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  const staticDir = path.join(appRoot, 'web', 'dist');
  const binary = claudeBinaryPath();
  const logFile = path.join(app.getPath('userData'), 'tta-claude.log');
  const log = (m: string, ...r: unknown[]): void => {
    const line = `${new Date().toISOString()} ${m} ${r.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`;
    try {
      fs.appendFileSync(logFile, line);
    } catch {
      /* */
    }
    console.log(line.trim());
  };
  log(`[desktop] claude binary: ${binary || 'SDK (standart)'}; electron ${process.versions.electron}`);
  return createApp({
    config: {
      dataDir,
      host: '127.0.0.1',
      port: 0,
      desktop: true,
      hideApiKey: true,
      adminLogin: 'me',
      adminPassword: crypto.randomBytes(12).toString('hex'),
      claudeBinary: binary,
      basePath: '',
      cookieSecure: false,
      appName: process.env.APP_NAME ?? 'TTA CLAUDE',
    },
    staticDir,
    desktopToken: token,
    log,
  });
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 820,
    minHeight: 560,
    title: 'TTA CLAUDE',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#121216' : '#f6f6f8',
    icon: path.join(appRoot, 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadURL(`${server!.url}?token=${token}`);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(server!.url) === false) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.on('closed', () => (win = null));
  if (process.env.TTA_SHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void win!.webContents.capturePage().then((img) => {
          fs.writeFileSync(process.env.TTA_SHOT!, img.toPNG());
          app.quit();
        });
      }, 2500);
    });
  }
}

const menu = Menu.buildFromTemplate([
  { role: 'editMenu' },
  { role: 'viewMenu' },
  { role: 'windowMenu' },
]);
Menu.setApplicationMenu(menu);

ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('reveal', (_e, p: string) => shell.showItemInFolder(p));
ipcMain.handle('open-path', (_e, p: string) => shell.openPath(p));
ipcMain.handle('open-external', (_e, url: string) => (/^https?:\/\//.test(url) ? shell.openExternal(url) : undefined));

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(async () => {
    try {
      server = await startServer();
      createWindow();
    } catch (e) {
      dialog.showErrorBox('TTA CLAUDE', 'Server ishga tushmadi: ' + String((e as Error).message));
      app.quit();
    }
  });
  app.on('window-all-closed', () => {
    void server?.close().finally(() => app.quit());
  });
}
