// Watch client TS + CSS/HTML, trigger live-reload in browser via SSE.
import { context } from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { createServer } from 'http';
import chokidar from 'chokidar';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// ── SSE live-reload server on port 4568 ──────────────────────────────────────
const clients = new Set();

const lrServer = createServer((req, res) => {
  if (req.url === '/esbuild') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('data: connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
  } else {
    res.writeHead(404);
    res.end();
  }
});
lrServer.listen(4568, () => console.log('  🔄 Live-reload SSE on :4568'));

function notifyClients(label) {
  console.log(`  🔄 Reload → ${label}`);
  for (const res of clients) {
    res.write('data: reload\n\n');
  }
}

// ── esbuild watch (client TS) ─────────────────────────────────────────────────
const ctx = await context({
  entryPoints: [join(root, 'src/client/app.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'NotasApp',
  outfile: join(root, 'public/js/app.bundle.js'),
  sourcemap: true,
  target: ['esnext'],
  logLevel: 'silent',
  plugins: [{
    name: 'reload-on-build',
    setup(build) {
      build.onEnd(result => {
        if (result.errors.length === 0) {
          notifyClients('app.ts');
        } else {
          console.error('  ❌ TS build errors:', result.errors.length);
        }
      });
    },
  }],
});

await ctx.watch();
console.log('  👀 Watching src/client/**/*.ts');

// ── chokidar: watch public/ directory for CSS and HTML changes ────────────────
// Watch the directory directly (not a glob) — most reliable on macOS
const WATCH_EXTS = new Set(['.css', '.html']);

chokidar.watch(join(root, 'public'), {
  ignoreInitial: true,
  ignored: [
    join(root, 'public/js'),  // ignore bundle output (handled by esbuild plugin)
  ],
  awaitWriteFinish: { stabilityThreshold: 80, pollInterval: 20 },
}).on('change', (filePath) => {
  const ext = filePath.split('.').pop();
  if (WATCH_EXTS.has('.' + ext)) {
    notifyClients(filePath.replace(root + '/', ''));
  }
}).on('error', (err) => {
  console.error('  ❌ Watcher error:', err);
});

console.log('  👀 Watching public/ (.css, .html)');
