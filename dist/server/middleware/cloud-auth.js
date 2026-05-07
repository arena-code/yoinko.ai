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
import path from 'path';
import fs from 'fs';
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { CLOUD_DATA_ROOT } from '../tenant-context.js';
const CLOUD_ENABLED = process.env.YOINKO_CLOUD === 'true';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
// JWKS for verifying Supabase ES256 JWTs (auto-caches keys)
const JWKS = SUPABASE_URL
    ? createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`))
    : null;
// ── Tenant cache (avoids Supabase REST call on every request) ─────────────────
const tenantCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
// Routes that should NOT require auth
const PUBLIC_PATHS = ['/api/health'];
function extractToken(req) {
    const cookieHeader = req.headers.cookie || '';
    // 1. Legacy yoinko_token cookie (from token relay)
    const yoinkoMatch = cookieHeader.match(/yoinko_token=([^;]+)/);
    if (yoinkoMatch)
        return yoinkoMatch[1];
    // 2. Supabase SSR cookie (shared via domain=.yoinko.ai)
    //    Format: sb-<ref>-auth-token or chunked sb-<ref>-auth-token.0, .1, etc.
    const supabaseToken = extractSupabaseCookie(cookieHeader);
    if (supabaseToken)
        return supabaseToken;
    // 3. Authorization header
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer '))
        return authHeader.slice(7);
    return null;
}
function extractSupabaseCookie(cookieHeader) {
    try {
        // Parse all cookies
        const cookies = {};
        cookieHeader.split(';').forEach(c => {
            const [name, ...rest] = c.trim().split('=');
            if (name)
                cookies[name] = rest.join('=');
        });
        // Find the Supabase auth cookie (sb-<ref>-auth-token)
        const authCookieName = Object.keys(cookies).find(name => name.match(/^sb-[^-]+-auth-token$/));
        let raw = '';
        if (authCookieName && cookies[authCookieName]) {
            // Single cookie (not chunked)
            raw = decodeURIComponent(cookies[authCookieName]);
        }
        else {
            // Chunked cookies: sb-<ref>-auth-token.0, sb-<ref>-auth-token.1, ...
            const chunkPrefix = Object.keys(cookies).find(name => name.match(/^sb-[^-]+-auth-token\.0$/));
            if (!chunkPrefix)
                return null;
            const prefix = chunkPrefix.replace(/\.0$/, '');
            const chunks = [];
            for (let i = 0;; i++) {
                const chunk = cookies[`${prefix}.${i}`];
                if (!chunk)
                    break;
                chunks.push(decodeURIComponent(chunk));
            }
            raw = chunks.join('');
        }
        if (!raw)
            return null;
        // Parse the JSON — Supabase stores { access_token, refresh_token, ... }
        // The value might be base64-encoded or plain JSON
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            // Try base64 decode
            parsed = JSON.parse(Buffer.from(raw, 'base64').toString());
        }
        return parsed?.access_token || null;
    }
    catch {
        return null;
    }
}
// Extracts refresh_token from the Supabase SSR cookie (same parsing as above)
function extractRefreshToken(req) {
    try {
        const cookieHeader = req.headers.cookie || '';
        const cookies = {};
        cookieHeader.split(';').forEach(c => {
            const [name, ...rest] = c.trim().split('=');
            if (name)
                cookies[name] = rest.join('=');
        });
        const authCookieName = Object.keys(cookies).find(n => n.match(/^sb-[^-]+-auth-token$/));
        let raw = '';
        if (authCookieName && cookies[authCookieName]) {
            raw = decodeURIComponent(cookies[authCookieName]);
        }
        else {
            const chunkPrefix = Object.keys(cookies).find(n => n.match(/^sb-[^-]+-auth-token\.0$/));
            if (!chunkPrefix)
                return null;
            const prefix = chunkPrefix.replace(/\.0$/, '');
            const chunks = [];
            for (let i = 0;; i++) {
                const chunk = cookies[`${prefix}.${i}`];
                if (!chunk)
                    break;
                chunks.push(decodeURIComponent(chunk));
            }
            raw = chunks.join('');
        }
        if (!raw)
            return null;
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            parsed = JSON.parse(Buffer.from(raw, 'base64').toString());
        }
        return parsed?.refresh_token || null;
    }
    catch {
        return null;
    }
}
// Uses the refresh_token to obtain a new access_token from Supabase.
// Returns the new access_token string, or null on failure.
async function refreshAccessToken(refreshToken) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY)
        return null;
    try {
        const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_ANON_KEY,
            },
            body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!res.ok)
            return null;
        const data = await res.json();
        return data.access_token ?? null;
    }
    catch {
        return null;
    }
}
async function lookupTenant(userId) {
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
        const rows = await res.json();
        if (!rows.length)
            return null;
        const row = rows[0];
        if (row.status !== 'active')
            return null;
        const tenant = {
            subdomain: row.subdomain,
            status: row.status,
            dataDir: path.join(CLOUD_DATA_ROOT, row.subdomain),
        };
        // Cache it
        tenantCache.set(userId, { tenant, expiresAt: Date.now() + CACHE_TTL_MS });
        return tenant;
    }
    catch (err) {
        console.error('[cloud-auth] Tenant lookup error:', err);
        return null;
    }
}
function ensureTenantDir(dataDir) {
    if (fs.existsSync(dataDir))
        return;
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
export function cloudAuth(req, res, next) {
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
async function verifyAndContinue(token, req, res, next) {
    try {
        const { payload } = await jwtVerify(token, JWKS);
        const sub = payload.sub;
        const email = payload.email;
        // Look up tenant
        const tenant = await lookupTenant(sub);
        if (!tenant) {
            if (req.path.startsWith('/api/')) {
                res.status(403).json({ error: 'No active subscription' });
                return;
            }
            sendAuthBlockPage(res, 'no active subscription', 'you need an active yoinko cloud subscription to use this app.', 'go to dashboard', 'https://yoinko.ai/dashboard', true);
            return;
        }
        // Ensure tenant directory exists (lazy provisioning)
        ensureTenantDir(tenant.dataDir);
        // Attach to request for downstream use
        req.user = { id: sub, email, tenantId: tenant.subdomain };
        req.tenantDataDir = tenant.dataDir;
        next();
    }
    catch (err) {
        const code = err?.code;
        if (code === 'ERR_JWT_EXPIRED') {
            // ── Transparent token refresh ────────────────────────────────────────
            // Extract the refresh_token from the Supabase cookie and ask Supabase
            // for a new access_token.  If successful, store it in a yoinko_token
            // cookie (survives until browser closes) and retry verification so the
            // user never sees a logout screen.
            const refreshToken = extractRefreshToken(req);
            if (refreshToken) {
                console.log('[cloud-auth] Access token expired — attempting silent refresh');
                const newAccessToken = await refreshAccessToken(refreshToken);
                if (newAccessToken) {
                    console.log('[cloud-auth] Token refreshed successfully');
                    // Set the new access token as a session cookie so the next request uses it
                    res.setHeader('Set-Cookie', `yoinko_token=${encodeURIComponent(newAccessToken)}; Path=/; HttpOnly; SameSite=Lax; Secure`);
                    // Retry verification with the fresh token
                    return verifyAndContinue(newAccessToken, req, res, next);
                }
                console.log('[cloud-auth] Token refresh failed — refresh token may be revoked');
            }
            // Refresh unavailable or failed — redirect to sign-in
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
function sendAuthBlockPage(res, title, message, buttonLabel, buttonUrl, showSignOut = false) {
    const isExpired = title.includes('expired');
    const isSub = title.includes('subscription');
    const iconSvg = isSub
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 00-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 00-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 000-7.78z"/></svg>`
        : isExpired
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>`;
    res.status(401).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>yoinko — ${title}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

    body {
      font-family: 'Fredoka', sans-serif;
      background: #0f0f1a;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      position: relative;
    }

    /* ── Mesh gradient background ── */
    .bg-mesh {
      position: fixed; inset: 0;
      background:
        radial-gradient(ellipse 80% 60% at 15% 30%, rgba(255,90,54,.12) 0%, transparent 70%),
        radial-gradient(ellipse 60% 80% at 85% 70%, rgba(255,160,100,.08) 0%, transparent 70%),
        radial-gradient(ellipse 50% 50% at 50% 50%, rgba(100,80,200,.05) 0%, transparent 70%);
      animation: mesh 12s ease-in-out infinite alternate;
    }
    @keyframes mesh {
      0% { filter: hue-rotate(0deg); opacity: .8; }
      100% { filter: hue-rotate(10deg); opacity: 1; }
    }

    /* ── Floating orbs ── */
    .orb {
      position: fixed; border-radius: 50%;
      filter: blur(80px); opacity: .35;
      animation: orbF 8s ease-in-out infinite alternate;
    }
    .o1 { width:300px;height:300px;background:rgba(255,90,54,.15);top:-100px;left:-80px;animation-duration:10s }
    .o2 { width:200px;height:200px;background:rgba(255,160,100,.1);bottom:-60px;right:-40px;animation-delay:3s;animation-duration:8s }
    .o3 { width:150px;height:150px;background:rgba(120,100,255,.08);top:40%;right:15%;animation-delay:5s;animation-duration:12s }
    @keyframes orbF {
      0% { transform: translate(0,0) scale(1); }
      100% { transform: translate(30px,-20px) scale(1.1); }
    }

    /* ── Noise texture ── */
    .noise {
      position: fixed; inset: 0; opacity: .03;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      pointer-events: none;
    }

    /* ── Content ── */
    .wrap {
      position: relative; z-index: 10;
      text-align: center; max-width: 440px; width: 90%;
    }

    .logo {
      width: 120px; margin-bottom: 36px;
      opacity: .85; filter: brightness(0) invert(1);
      animation: fadeIn .6s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: .85; transform: translateY(0); }
    }

    .card {
      background: rgba(255,255,255,.03);
      border: 1px solid rgba(255,255,255,.06);
      backdrop-filter: blur(40px) saturate(1.2);
      -webkit-backdrop-filter: blur(40px) saturate(1.2);
      border-radius: 28px;
      padding: 52px 40px 44px;
      animation: cardIn .6s cubic-bezier(.16,1,.3,1) .1s both;
      position: relative; overflow: hidden;
    }
    .card::before {
      content: ''; position: absolute; inset: -1px;
      border-radius: 28px;
      background: linear-gradient(135deg, rgba(255,90,54,.08) 0%, transparent 40%, transparent 60%, rgba(255,160,100,.04) 100%);
      pointer-events: none;
    }
    @keyframes cardIn {
      from { opacity: 0; transform: translateY(24px) scale(.96); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }

    .icon-wrap {
      width: 64px; height: 64px; border-radius: 20px;
      background: rgba(255,90,54,.1);
      border: 1px solid rgba(255,90,54,.15);
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 28px;
      animation: pulse 3s ease-in-out infinite;
    }
    @keyframes pulse {
      0%,100% { box-shadow: 0 0 0 0 rgba(255,90,54,.1); }
      50% { box-shadow: 0 0 0 12px rgba(255,90,54,0); }
    }
    .icon-wrap svg { width: 28px; height: 28px; stroke: #FF5A36; }

    .card h1 {
      font-size: 24px; font-weight: 600;
      color: rgba(255,255,255,.92);
      margin-bottom: 12px; letter-spacing: -.03em; line-height: 1.2;
    }
    .card p {
      font-size: 14px; color: rgba(255,255,255,.38);
      line-height: 1.7; margin-bottom: 32px;
      max-width: 320px; margin-left: auto; margin-right: auto;
    }

    .cta {
      display: inline-flex; align-items: center; gap: 8px;
      font-family: 'Fredoka', sans-serif;
      font-size: 15px; font-weight: 600; color: #fff;
      background: linear-gradient(135deg, #FF5A36, #ff7a55);
      border: none; border-radius: 14px; padding: 14px 36px;
      cursor: pointer; text-decoration: none;
      transition: all .2s cubic-bezier(.16,1,.3,1);
      box-shadow: 0 4px 16px rgba(255,90,54,.25), 0 1px 3px rgba(0,0,0,.2), inset 0 1px 0 rgba(255,255,255,.15);
      position: relative; overflow: hidden;
    }
    .cta::after {
      content: ''; position: absolute; inset: 0;
      background: linear-gradient(135deg, transparent, rgba(255,255,255,.1));
      opacity: 0; transition: opacity .2s;
    }
    .cta:hover {
      transform: translateY(-2px);
      box-shadow: 0 8px 28px rgba(255,90,54,.35), 0 2px 6px rgba(0,0,0,.2), inset 0 1px 0 rgba(255,255,255,.15);
    }
    .cta:hover::after { opacity: 1; }
    .cta:active { transform: translateY(0); }
    .cta svg { width: 16px; height: 16px; transition: transform .2s; }
    .cta:hover svg { transform: translateX(3px); }

    .signout { margin-top: 20px; }
    .signout a {
      font-size: 13px; color: rgba(255,255,255,.25);
      text-decoration: none; transition: all .2s;
      padding: 6px 14px; border-radius: 8px;
    }
    .signout a:hover {
      color: rgba(255,255,255,.6);
      background: rgba(255,255,255,.04);
    }

    .foot {
      margin-top: 24px; font-size: 11px;
      color: rgba(255,255,255,.12); letter-spacing: .02em;
    }
    .foot a {
      color: rgba(255,255,255,.2);
      text-decoration: none; transition: color .2s;
    }
    .foot a:hover { color: rgba(255,255,255,.45); }

    @media (max-width: 480px) {
      .card { padding: 40px 28px 36px; }
      .card h1 { font-size: 20px; }
    }
  </style>
</head>
<body>
  <div class="bg-mesh"></div>
  <div class="orb o1"></div>
  <div class="orb o2"></div>
  <div class="orb o3"></div>
  <div class="noise"></div>
  <div class="wrap">
    <img src="/yoinko-logo.svg" alt="yoinko" class="logo" onerror="this.style.display='none'">
    <div class="card">
      <div class="icon-wrap">${iconSvg}</div>
      <h1>${title}</h1>
      <p>${message}</p>
      <a href="${buttonUrl}" class="cta">
        ${buttonLabel}
        <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
      </a>
      ${showSignOut ? `<div class="signout"><a href="/auth/logout" onclick="try{localStorage.clear();sessionStorage.clear()}catch(e){}">sign out of this account</a></div>` : ''}
      <div class="foot"><a href="https://yoinko.ai">yoinko.ai</a></div>
    </div>
  </div>
</body>
</html>`);
}
//# sourceMappingURL=cloud-auth.js.map