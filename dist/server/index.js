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
import authRouter from './routes/auth.js';
import { migrateOnStartup } from './projects.js';
import { cloudAuth } from './middleware/cloud-auth.js';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const CLOUD_ENABLED = process.env.YOINKO_CLOUD === 'true';
// ── Run startup migration (flat → project layout) ─────────────────────────────
migrateOnStartup();
// ── Middleware ────────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
// ── Static frontend ───────────────────────────────────────────────────────────
// In dev (tsx): __dirname is src/server, so go up 2 levels to project root/public
// In prod (dist): __dirname is dist/server, so go up 2 levels to /app/public
const publicDir = path.join(__dirname, '..', '..', 'public');
// Don't auto-serve index.html — let it go through cloudAuth via the SPA fallback
app.use(express.static(publicDir, { index: false }));
// ── Auth routes (login/callback/logout — before cloudAuth) ────────────────────
if (CLOUD_ENABLED) {
    app.use('/auth', authRouter);
}
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
    res.json({ status: 'ok', version: '1.0.0', app: 'yoinko', cloud: CLOUD_ENABLED });
});
// ── User info (cloud mode) ────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
    const user = req.user;
    if (!user) {
        res.json({ user: null });
        return;
    }
    res.json({
        user: {
            email: user.email || null,
            tenantId: user.tenantId || null,
        },
    });
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
    if (CLOUD_ENABLED) {
        const vars = {
            YOINKO_CLOUD: '✓',
            SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET ? `✓ (${process.env.SUPABASE_JWT_SECRET.length} chars)` : '✗ MISSING',
            NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL || '✗ MISSING',
            NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ? '✓' : '✗ MISSING',
            SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? `✓ (${process.env.SUPABASE_SERVICE_ROLE_KEY.length} chars)` : '✗ MISSING',
            YOINKO_DATA_DIR: process.env.YOINKO_DATA_DIR || '(default: ./data)',
        };
        console.log('  ☁️  Cloud mode enabled:');
        for (const [key, val] of Object.entries(vars)) {
            console.log(`     ${key}: ${val}`);
        }
        console.log('');
    }
    else {
        console.log('  📦 Self-hosted mode\n');
    }
});
// ── Graceful shutdown (prevents tsx "Force killing" warning) ──────────────────
function shutdown(signal) {
    console.log(`\n  Received ${signal}, shutting down…`);
    server.close(() => {
        console.log('  Server closed.');
        process.exit(0);
    });
    // Hard exit after 2s in case connections linger
    setTimeout(() => process.exit(1), 2000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
//# sourceMappingURL=index.js.map