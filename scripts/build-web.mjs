// Web interfeysni esbuild bilan yig'ish: web/src → web/dist (index.html, assets/app.js, assets/app.css).
import { build, context } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const out = path.join(root, 'web', 'dist');
const watch = process.argv.includes('--watch');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'assets'), { recursive: true });
fs.copyFileSync(path.join(root, 'web', 'public', 'index.html'), path.join(out, 'index.html'));
fs.copyFileSync(path.join(root, 'web', 'public', 'icon.svg'), path.join(out, 'assets', 'icon.svg'));
fs.copyFileSync(path.join(root, 'web', 'src', 'styles.css'), path.join(out, 'assets', 'app.css'));

const opts = {
  entryPoints: [path.join(root, 'web', 'src', 'main.tsx')],
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: ['es2020', 'chrome100', 'safari15'],
  format: 'esm',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  outfile: path.join(out, 'assets', 'app.js'),
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
};
if (watch) {
  const ctx = await context(opts);
  await ctx.watch();
  fs.watch(path.join(root, 'web', 'src', 'styles.css'), () => fs.copyFileSync(path.join(root, 'web', 'src', 'styles.css'), path.join(out, 'assets', 'app.css')));
  console.log('kuzatilmoqda…');
} else {
  await build(opts);
}
