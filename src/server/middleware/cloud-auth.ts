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
import jwt from 'jsonwebtoken';
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
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || '';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

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
    // For API routes, return 401
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    // For page requests, redirect to login
    const redirect = encodeURIComponent(`https://${req.hostname}`);
    res.redirect(`https://yoinko.ai/login?redirect=${redirect}`);
    return;
  }

  if (!JWT_SECRET) {
    console.error('[cloud-auth] SUPABASE_JWT_SECRET not set');
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as SupabaseJwtPayload;

    // Look up tenant and set data dir
    lookupTenant(payload.sub).then(tenant => {
      if (!tenant) {
        if (req.path.startsWith('/api/')) {
          res.status(403).json({ error: 'No active subscription' });
          return;
        }
        res.redirect('https://yoinko.ai/dashboard');
        return;
      }

      // Ensure tenant directory exists (lazy provisioning)
      ensureTenantDir(tenant.dataDir);

      // Attach to request for downstream use
      (req as any).user = {
        id: payload.sub,
        email: payload.email,
        tenantId: tenant.subdomain,
      };
      (req as any).tenantDataDir = tenant.dataDir;

      next();
    }).catch(err => {
      console.error('[cloud-auth] Tenant lookup failed:', err);
      res.status(500).json({ error: 'Internal error' });
    });

  } catch (err: any) {
    if (err.name === 'TokenExpiredError') {
      if (req.path.startsWith('/api/')) {
        res.status(401).json({ error: 'Token expired' });
        return;
      }
      const redirect = encodeURIComponent(`https://${req.hostname}`);
      res.redirect(`https://yoinko.ai/login?redirect=${redirect}`);
      return;
    }

    console.error('[cloud-auth] JWT verify failed:', err.name, err.message);
    // Clear bad cookie so user can re-authenticate
    res.clearCookie('yoinko_token');
    if (req.path.startsWith('/api/')) {
      res.status(403).json({ error: 'Invalid token' });
      return;
    }
    const redirect = encodeURIComponent(`https://${req.hostname}`);
    res.redirect(`https://yoinko.ai/login?redirect=${redirect}`);
  }
}
