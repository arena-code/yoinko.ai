// src/server/middleware/cloud-auth.ts
// Cloud-only authentication middleware.
// Active ONLY when YOINKO_CLOUD=true. Self-hosted mode skips this entirely.
//
// Validates Supabase JWTs and resolves the user's tenant directory.
// On first login, creates the tenant's data directory with seed content.
//
// Required env vars (cloud only):
//   YOINKO_CLOUD=true
//   SUPABASE_JWT_SECRET=<your-supabase-jwt-secret>
//   NEXT_PUBLIC_SUPABASE_URL=<supabase-url> (for tenant lookup)
//   SUPABASE_SERVICE_ROLE_KEY=<service-role-key> (for tenant lookup)

import type { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { CLOUD_DATA_ROOT } from '../tenant-context.js';

interface SupabaseJwtPayload {
  sub: string;          // user id
  email?: string;
  role?: string;
  aud?: string;
  exp?: number;
  iat?: number;
}

interface TenantInfo {
  subdomain: string;
  status: string;
  dataDir: string;
}

const CLOUD_ENABLED = process.env.YOINKO_CLOUD === 'true';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

// JWKS for verifying Supabase ES256 JWTs (auto-caches keys)
const JWKS = SUPABASE_URL
  ? createRemoteJWKSet(new URL(`${SUPABASE_URL}/.well-known/jwks.json`))
  : null;

// ── Tenant cache (avoids Supabase REST call on every request) ─────────────────
const tenantCache = new Map<string, { tenant: TenantInfo; expiresAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Routes that should NOT require auth
const PUBLIC_PATHS = ['/api/health'];

function extractToken(req: Request): string | null {
  const cookieHeader = req.headers.cookie || '';

  // 1. Legacy yoinko_token cookie (from token relay)
  const yoinkoMatch = cookieHeader.match(/yoinko_token=([^;]+)/);
  if (yoinkoMatch) return yoinkoMatch[1];

  // 2. Supabase SSR cookie (shared via domain=.yoinko.ai)
  //    Format: sb-<ref>-auth-token or chunked sb-<ref>-auth-token.0, .1, etc.
  const supabaseToken = extractSupabaseCookie(cookieHeader);
  if (supabaseToken) return supabaseToken;

  // 3. Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) return authHeader.slice(7);

  return null;
}

function extractSupabaseCookie(cookieHeader: string): string | null {
  try {
    // Parse all cookies
    const cookies: Record<string, string> = {};
    cookieHeader.split(';').forEach(c => {
      const [name, ...rest] = c.trim().split('=');
      if (name) cookies[name] = rest.join('=');
    });

    // Find the Supabase auth cookie (sb-<ref>-auth-token)
    const authCookieName = Object.keys(cookies).find(
      name => name.match(/^sb-[^-]+-auth-token$/)
    );

    let raw = '';
    if (authCookieName && cookies[authCookieName]) {
      // Single cookie (not chunked)
      raw = decodeURIComponent(cookies[authCookieName]);
    } else {
      // Chunked cookies: sb-<ref>-auth-token.0, sb-<ref>-auth-token.1, ...
      const chunkPrefix = Object.keys(cookies).find(
        name => name.match(/^sb-[^-]+-auth-token\.0$/)
      );
      if (!chunkPrefix) return null;

      const prefix = chunkPrefix.replace(/\.0$/, '');
      const chunks: string[] = [];
      for (let i = 0; ; i++) {
        const chunk = cookies[`${prefix}.${i}`];
        if (!chunk) break;
        chunks.push(decodeURIComponent(chunk));
      }
      raw = chunks.join('');
    }

    if (!raw) return null;

    // Parse the JSON — Supabase stores { access_token, refresh_token, ... }
    // The value might be base64-encoded or plain JSON
    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Try base64 decode
      parsed = JSON.parse(Buffer.from(raw, 'base64').toString());
    }

    return parsed?.access_token || null;
  } catch {
    return null;
  }
}

async function lookupTenant(userId: string): Promise<TenantInfo | null> {
  // Check cache first
  const cached = tenantCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.tenant;
  }

  // Fetch from Supabase REST API
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[cloud-auth] SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    return null;
  }

  try {
    const url = `${SUPABASE_URL}/rest/v1/tenants?user_id=eq.${userId}&select=subdomain,status&limit=1`;
    const res = await fetch(url, {
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    });

    if (!res.ok) {
      console.error(`[cloud-auth] Supabase lookup failed: ${res.status}`);
      return null;
    }

    const rows = await res.json() as Array<{ subdomain: string; status: string }>;
    if (!rows.length) return null;

    const row = rows[0];
    if (row.status !== 'active') return null;

    const tenant: TenantInfo = {
      subdomain: row.subdomain,
      status: row.status,
      dataDir: path.join(CLOUD_DATA_ROOT, row.subdomain),
    };

    // Cache it
    tenantCache.set(userId, { tenant, expiresAt: Date.now() + CACHE_TTL_MS });
    return tenant;
  } catch (err) {
    console.error('[cloud-auth] Tenant lookup error:', err);
    return null;
  }
}

function ensureTenantDir(dataDir: string): void {
  if (fs.existsSync(dataDir)) return;

  console.log(`[cloud-auth] First login — creating tenant dir: ${dataDir}`);
  fs.mkdirSync(dataDir, { recursive: true });

  // Create default project structure
  const defaultDir = path.join(dataDir, 'default', 'pages');
  fs.mkdirSync(defaultDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'default', 'uploads'), { recursive: true });

  // Seed welcome page
  const gettingStarted = path.join(defaultDir, '1 - Getting Started');
  fs.mkdirSync(gettingStarted, { recursive: true });
  fs.writeFileSync(path.join(gettingStarted, '01 - Welcome.md'), `# Welcome to yoınko Cloud ☁️

Your personal knowledge base is ready!

## Quick Start

1. Click the folder name to start adding pages
2. Use the **+ New Page** / **Folder** buttons to create content
3. Configure AI in **Settings** ⚙️ (gear icon)
4. Open the 💬 chat to ask AI anything about a page

---

> **Tip:** Your data is stored securely in the cloud and synced automatically.
`);

  const notesDir = path.join(defaultDir, '2 - My Notes');
  fs.mkdirSync(notesDir, { recursive: true });
  fs.writeFileSync(path.join(notesDir, '01 - My First Note.md'), `# My First Note

Click **Edit** in the top bar to start writing.

## Ideas

- 

## Tasks

- [ ] 

---

*Created with yoınko Cloud*
`);

  // Write project registry
  fs.writeFileSync(path.join(dataDir, 'projects.json'), JSON.stringify([{
    id: 'default',
    name: 'Default',
    created_at: new Date().toISOString(),
  }], null, 2));
}

export function cloudAuth(req: Request, res: Response, next: NextFunction): void {
  // Self-hosted mode: skip auth entirely
  if (!CLOUD_ENABLED) {
    next();
    return;
  }

  // Allow public paths
  if (PUBLIC_PATHS.some(p => req.path.startsWith(p))) {
    next();
    return;
  }

  // Allow static assets (CSS, JS, images, fonts)
  if (req.path.match(/\.(js|css|png|jpg|jpeg|svg|ico|woff2?|ttf|eot|map)$/)) {
    next();
    return;
  }

  const token = extractToken(req);

  if (!token) {
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    sendAuthBlockPage(res, 'sign in required', 'you need to sign in to access your yoinko cloud instance.', 'sign in', '/auth/login');
    return;
  }

  if (!JWKS) {
    console.error('[cloud-auth] NEXT_PUBLIC_SUPABASE_URL not set — cannot verify JWTs');
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  // Verify JWT using Supabase JWKS (handles ES256, RS256, HS256 automatically)
  verifyAndContinue(token, req, res, next);
}

async function verifyAndContinue(token: string, req: Request, res: Response, next: NextFunction) {
  try {
    const { payload } = await jwtVerify(token, JWKS!);
    const sub = payload.sub as string;
    const email = (payload as any).email as string | undefined;

    // Look up tenant
    const tenant = await lookupTenant(sub);
    if (!tenant) {
      if (req.path.startsWith('/api/')) {
        res.status(403).json({ error: 'No active subscription' });
        return;
      }
      sendAuthBlockPage(res, 'no active subscription', 'you need an active yoinko cloud subscription to use this app.', 'go to dashboard', 'https://yoinko.ai/dashboard');
      return;
    }

    // Ensure tenant directory exists (lazy provisioning)
    ensureTenantDir(tenant.dataDir);

    // Attach to request for downstream use
    (req as any).user = { id: sub, email, tenantId: tenant.subdomain };
    (req as any).tenantDataDir = tenant.dataDir;

    next();
  } catch (err: any) {
    const code = err?.code;

    if (code === 'ERR_JWT_EXPIRED') {
      if (req.path.startsWith('/api/')) {
        res.status(401).json({ error: 'Token expired' });
        return;
      }
      res.clearCookie('yoinko_token');
      sendAuthBlockPage(res, 'session expired', 'your session has expired. please sign in again to continue.', 'sign in again', '/auth/login');
      return;
    }

    console.error('[cloud-auth] JWT verify failed:', err.code || err.name, err.message);
    res.clearCookie('yoinko_token');
    if (req.path.startsWith('/api/')) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }
    sendAuthBlockPage(res, 'authentication failed', 'your authentication token is invalid. please sign in again.', 'sign in again', '/auth/login');
  }
}

// ── Blocking auth page ────────────────────────────────────────────────────────
function sendAuthBlockPage(res: Response, title: string, message: string, buttonLabel: string, buttonUrl: string) {
  res.status(401).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>yoinko — ${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: 'Fredoka', sans-serif;
      background: #1a1a2e;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    /* Animated background */
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse at 20% 50%, rgba(255, 90, 54, 0.08) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 50%, rgba(255, 138, 101, 0.06) 0%, transparent 50%);
      animation: bgPulse 6s ease-in-out infinite alternate;
    }

    @keyframes bgPulse {
      0% { opacity: 0.6; }
      100% { opacity: 1; }
    }

    .auth-block {
      position: relative;
      z-index: 10;
      text-align: center;
      max-width: 420px;
      width: 90%;
    }

    .auth-block-logo {
      width: 140px;
      margin-bottom: 32px;
      opacity: 0.9;
      filter: brightness(0) invert(1);
    }

    .auth-block-card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(20px);
      -webkit-backdrop-filter: blur(20px);
      border-radius: 24px;
      padding: 48px 36px 40px;
      animation: slideUp 0.5s ease-out;
    }

    @keyframes slideUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .auth-block-icon {
      width: 56px;
      height: 56px;
      border-radius: 16px;
      background: rgba(255, 90, 54, 0.12);
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 24px;
    }

    .auth-block-icon svg {
      width: 28px;
      height: 28px;
      stroke: #FF5A36;
    }

    .auth-block-card h1 {
      font-size: 22px;
      font-weight: 500;
      color: rgba(255, 255, 255, 0.9);
      margin-bottom: 10px;
      letter-spacing: -0.02em;
    }

    .auth-block-card p {
      font-size: 14px;
      color: rgba(255, 255, 255, 0.4);
      line-height: 1.65;
      margin-bottom: 28px;
    }

    .auth-block-btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      font-family: 'Fredoka', sans-serif;
      font-size: 15px;
      font-weight: 600;
      color: white;
      background: linear-gradient(135deg, #FF5A36, #ff8a65);
      border: none;
      border-radius: 14px;
      padding: 14px 32px;
      cursor: pointer;
      text-decoration: none;
      transition: transform 0.15s, box-shadow 0.15s;
      box-shadow: 0 4px 20px rgba(255, 90, 54, 0.3);
    }

    .auth-block-btn:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 28px rgba(255, 90, 54, 0.4);
    }

    .auth-block-btn:active {
      transform: translateY(0);
    }

    .auth-block-footer {
      margin-top: 20px;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.2);
    }

    .auth-block-footer a {
      color: rgba(255, 255, 255, 0.35);
      text-decoration: none;
    }

    .auth-block-footer a:hover {
      color: rgba(255, 255, 255, 0.55);
    }
  </style>
</head>
<body>
  <div class="auth-block">
    <img src="/yoinko-logo.svg" alt="yoinko" class="auth-block-logo" onerror="this.style.display='none'">
    <div class="auth-block-card">
      <div class="auth-block-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
          <path d="M7 11V7a5 5 0 0110 0v4" />
        </svg>
      </div>
      <h1>${title}</h1>
      <p>${message}</p>
      <a href="${buttonUrl}" class="auth-block-btn">${buttonLabel} →</a>
      <div class="auth-block-footer">
        <a href="https://yoinko.ai">yoinko.ai</a>
      </div>
    </div>
  </div>
</body>
</html>`);
}

