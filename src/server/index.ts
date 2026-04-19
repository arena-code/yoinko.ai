// src/server/index.ts — Express app entry point
import express from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';

import pagesRouter from './routes/pages.js';
import assetsRouter from './routes/assets.js';
import aiRouter from './routes/ai.js';
import settingsRouter from './routes/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Static frontend ───────────────────────────────────────────────────────────
// In dev (tsx): __dirname is src/server, so go up 3 levels to project root
// In prod (dist): __dirname is dist, so go up 2 levels
const isCompiled = __dirname.includes('/dist');
const publicDir = isCompiled
  ? path.join(__dirname, '..', 'public')
  : path.join(__dirname, '..', '..', 'public');

app.use(express.static(publicDir));

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/pages', pagesRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/settings', settingsRouter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', app: 'notas' });
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, () => {
  console.log(`\n  ╔══════════════════════════════════╗`);
  console.log(`  ║   yoınko — Knowledge Base        ║`);
  console.log(`  ║   http://localhost:${PORT}          ║`);
  console.log(`  ╚══════════════════════════════════╝\n`);
});

// ── Graceful shutdown (prevents tsx "Force killing" warning) ──────────────────
function shutdown(signal: string) {
  console.log(`\n  Received ${signal}, shutting down…`);
  server.close(() => {
    console.log('  Server closed.');
    process.exit(0);
  });
  // Hard exit after 2s in case connections linger
  setTimeout(() => process.exit(1), 2000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
