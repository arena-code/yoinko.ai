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
import storageRouter from './routes/storage.js';
import authRouter from './routes/auth.js';
import shareRouter from './routes/share.js';
import { migrateOnStartup } from './projects.js';
import { cloudAuth, invalidateTenantCache } from './middleware/cloud-auth.js';
import { workspaceAccessCheck } from './middleware/workspace-auth.js';
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
// ── Public read-only shares (must bypass cloudAuth) ───────────────────────────
app.use('/share', shareRouter);
// ── Admin endpoint: cache invalidation (before cloudAuth, shared-secret auth) ─
// The website calls this when it removes a member or revokes access so the
// notes app's tenant cache is busted immediately instead of waiting for TTL.
app.post('/api/admin/invalidate-tenant-cache', (req, res) => {
    const secret = process.env.YOINKO_ADMIN_SECRET;
    if (!secret) {
        res.status(503).json({ error: 'Admin endpoint not configured' });
        return;
    }
    const auth = req.headers.authorization || '';
    const provided = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (provided !== secret) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    const userId = req.body?.userId;
    if (typeof userId !== 'string' || userId.length === 0) {
        res.status(400).json({ error: 'Missing userId' });
        return;
    }
    const removed = invalidateTenantCache(userId);
    console.log(`[admin] Invalidated cache for ${userId} (existed=${removed})`);
    res.status(204).end();
});
// ── Cloud auth (no-op when YOINKO_CLOUD is not set) ───────────────────────────
app.use(cloudAuth);
// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/pages', workspaceAccessCheck, pagesRouter);
app.use('/api/assets', workspaceAccessCheck, assetsRouter);
app.use('/api/ai', workspaceAccessCheck, aiRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/projects', projectsRouter);
app.use('/api/storage', storageRouter);
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
            id: user.id || null,
            email: user.email || null,
            tenantId: user.tenantId || null,
            isOwner: req.isOwner ?? true,
            plan: req.tenantPlan ?? 'basic',
        },
    });
});
// ── Team members list (cloud, owner only) ────────────────────────────────────
// Returns all users who are members of the current tenant so the owner can
// pick from them when granting workspace access.
app.get('/api/me/team', async (req, res) => {
    if (!CLOUD_ENABLED) {
        res.json({ members: [] });
        return;
    }
    const supabaseTenantId = req.supabaseTenantId;
    if (!supabaseTenantId) {
        res.json({ members: [] });
        return;
    }
    const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
    const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
    if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
        res.json({ members: [] });
        return;
    }
    const headers = { 'apikey': SUPABASE_SERVICE_KEY, 'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}` };
    try {
        // 1. Get all user_ids in this tenant
        const memberRes = await fetch(`${SUPABASE_URL}/rest/v1/tenant_members?tenant_id=eq.${supabaseTenantId}&select=user_id`, { headers });
        if (!memberRes.ok) {
            res.json({ members: [] });
            return;
        }
        const memberRows = await memberRes.json();
        if (!memberRows.length) {
            res.json({ members: [] });
            return;
        }
        // 2. Fetch each user's email from the auth admin API (parallelised)
        const userDetails = await Promise.all(memberRows.map(async ({ user_id }) => {
            try {
                const r = await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user_id}`, { headers });
                if (!r.ok)
                    return null;
                const u = await r.json();
                return u.email ? { user_id: u.id, email: u.email } : null;
            }
            catch {
                return null;
            }
        }));
        res.json({ members: userDetails.filter(Boolean) });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
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