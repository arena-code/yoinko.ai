// src/server/index.ts — Express app entry point
import express from 'express';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';

import pagesRouter from './routes/pages.js';
import assetsRouter from './routes/assets.js';
import aiRouter from './routes/ai.js';
import settingsRouter from './routes/settings.js';
import projectsRouter from './routes/projects.js';
import { migrateOnStartup } from './projects.js';
import { cloudAuth } from './middleware/cloud-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── Run startup migration (flat → project layout) ─────────────────────────────
migrateOnStartup();

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Static frontend ───────────────────────────────────────────────────────────
// In dev (tsx): __dirname is src/server, so go up 2 levels to project root/public
// In prod (dist): __dirname is dist/server, so go up 2 levels to /app/public
const isCompiled = __dirname.includes('/dist');
const publicDir = isCompiled
  ? path.join(__dirname, '..', '..', 'public')
  : path.join(__dirname, '..', '..', 'public');

app.use(express.static(publicDir));

// ── Cloud token relay (sets auth cookie from query param) ─────────────────────
// Usage: notes.yoinko.ai/auth/login?token=<JWT>&redirect=/
// This lets the yoinko.ai website hand off auth to the notes subdomain.
app.get('/auth/login', (req, res) => {
  const token = req.query.token as string;
  const redirect = (req.query.redirect as string) || '/';

  if (!token) {
    return void res.status(400).send('Missing token');
  }

  // Set the auth cookie on this domain
  res.cookie('yoinko_token', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  });

  res.redirect(redirect);
});

// ── Cloud auth (no-op when YOINKO_CLOUD is not set) ───────────────────────────
app.use(cloudAuth);

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/pages', pagesRouter);
app.use('/api/assets', assetsRouter);
app.use('/api/ai', aiRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/projects', projectsRouter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', app: 'yoinko' });
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

  // Cloud mode diagnostics
  const isCloud = process.env.YOINKO_CLOUD === 'true';
  if (isCloud) {
    const vars = {
      YOINKO_CLOUD: '✓',
      SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET ? `✓ (${process.env.SUPABASE_JWT_SECRET.length} chars)` : '✗ MISSING',
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || '✗ MISSING',
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? `✓ (${process.env.SUPABASE_SERVICE_ROLE_KEY.length} chars)` : '✗ MISSING',
      YOINKO_DATA_DIR: process.env.YOINKO_DATA_DIR || '(default: ./data)',
      NODE_ENV: process.env.NODE_ENV || 'development',
    };
    console.log('  ☁️  Cloud mode enabled:');
    for (const [key, val] of Object.entries(vars)) {
      console.log(`     ${key}: ${val}`);
    }
    console.log('');
  } else {
    console.log('  📦 Self-hosted mode\n');
  }
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
