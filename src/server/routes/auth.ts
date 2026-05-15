// src/server/routes/auth.ts — Cloud authentication routes
// Serves login page, callback handler, and token management.
// Active ONLY when YOINKO_CLOUD=true.

import { Router } from 'express';
import { clearAuthCookies, setAuthCookies } from '../auth-cookies.js';
import { posthog } from '../posthog.js';

function decodeJwtPayload(token: string): { sub?: string; email?: string } {
  try {
    return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  } catch { return {}; }
}

const router = Router();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

// ── GET /auth/login — Login page ──────────────────────────────────────────────
router.get('/login', (_req, res) => {
  res.send(loginPage());
});

// ── GET /auth/callback — OAuth callback handler ──────────────────────────────
router.get('/callback', (_req, res) => {
  res.send(callbackPage());
});

// ── POST /auth/set-token — Store JWT in httpOnly cookie ──────────────────────
router.post('/set-token', (req, res) => {
  const { access_token, refresh_token } = req.body;
  if (!access_token) {
    res.status(400).json({ error: 'Missing access_token' });
    return;
  }

  setAuthCookies(res, access_token, refresh_token);

  const payload = decodeJwtPayload(access_token);
  if (posthog && payload.sub) {
    posthog.identify({ distinctId: payload.sub, properties: { email: payload.email } });
    posthog.capture({ distinctId: payload.sub, event: 'user_signed_in', properties: { method: 'token' } });
  }

  res.json({ ok: true });
});

// ── POST /auth/logout — Clear ALL auth cookies ──────────────────────────────
router.post('/logout', (req, res) => {
  const cookieHeader = req.headers.cookie || '';

  // Extract user id from cookie token for analytics before clearing
  const yoinkoMatch = cookieHeader.match(/yoinko_token=([^;]+)/);
  const tokenForAnalytics = yoinkoMatch?.[1];
  const analyticsId = tokenForAnalytics ? decodeJwtPayload(tokenForAnalytics).sub : undefined;
  if (posthog && analyticsId) {
    posthog.capture({ distinctId: analyticsId, event: 'user_signed_out' });
  }

  clearAuthCookies(res);

  // Clear any Supabase SSR cookies (sb-<ref>-auth-token and chunked variants)
  const cookieNames = cookieHeader.split(';').map(c => c.trim().split('=')[0]).filter(Boolean);
  for (const name of cookieNames) {
    if (name.match(/^sb-[^-]+-auth-token/)) {
      res.clearCookie(name, { path: '/' });
      // Also try with domain variants
      res.clearCookie(name, { path: '/', domain: '.yoinko.ai' });
    }
  }

  res.json({ ok: true });
});

// ── GET /auth/logout — Clear cookies and redirect to login ───────────────────
router.get('/logout', (req, res) => {
  clearAuthCookies(res);

  const cookieHeader = req.headers.cookie || '';
  const cookieNames = cookieHeader.split(';').map(c => c.trim().split('=')[0]).filter(Boolean);
  for (const name of cookieNames) {
    if (name.match(/^sb-[^-]+-auth-token/)) {
      res.clearCookie(name, { path: '/' });
      res.clearCookie(name, { path: '/', domain: '.yoinko.ai' });
    }
  }

  res.redirect('/auth/login?signed_out=1');
});

// ── Login page HTML ──────────────────────────────────────────────────────────
function loginPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>yoinko — sign in</title>
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
    body::before {
      content: '';
      position: fixed;
      inset: 0;
      background:
        radial-gradient(ellipse at 20% 50%, rgba(255, 90, 54, 0.08) 0%, transparent 50%),
        radial-gradient(ellipse at 80% 50%, rgba(255, 138, 101, 0.06) 0%, transparent 50%);
      animation: bgPulse 6s ease-in-out infinite alternate;
    }
    @keyframes bgPulse { 0% { opacity: 0.6; } 100% { opacity: 1; } }

    .login-wrap {
      position: relative; z-index: 10; text-align: center;
      max-width: 400px; width: 90%;
    }
    .login-logo {
      width: 140px; margin-bottom: 32px; opacity: 0.9;
      filter: brightness(0) invert(1);
    }
    .login-card {
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
      backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
      border-radius: 24px; padding: 40px 32px 36px;
      animation: slideUp 0.5s ease-out;
    }
    @keyframes slideUp {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .login-card h1 {
      font-size: 22px; font-weight: 500;
      color: rgba(255, 255, 255, 0.9);
      margin-bottom: 6px; letter-spacing: -0.02em;
    }
    .login-card > p {
      font-size: 13px; color: rgba(255, 255, 255, 0.35);
      margin-bottom: 28px; line-height: 1.5;
    }

    /* ── Divider ── */
    .login-divider {
      display: flex; align-items: center; gap: 12px;
      margin: 20px 0; color: rgba(255,255,255,0.15);
      font-size: 11px; text-transform: uppercase; letter-spacing: 1.5px;
    }
    .login-divider::before, .login-divider::after {
      content: ''; flex: 1; height: 1px; background: rgba(255,255,255,0.08);
    }

    /* ── OAuth buttons ── */
    .oauth-btn {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; padding: 13px 20px;
      border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
      background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.8);
      font-family: 'Fredoka', sans-serif; font-size: 14px; font-weight: 500;
      cursor: pointer; transition: all 0.2s; margin-bottom: 10px;
    }
    .oauth-btn:hover {
      background: rgba(255,255,255,0.08); border-color: rgba(255,255,255,0.18);
      transform: translateY(-1px);
    }
    .oauth-btn:active { transform: translateY(0); }
    .oauth-btn svg { width: 18px; height: 18px; flex-shrink: 0; }

    /* ── Email form ── */
    .login-form { text-align: left; }
    .login-form label {
      display: block; font-size: 12px; color: rgba(255,255,255,0.35);
      margin-bottom: 6px; letter-spacing: 0.5px;
    }
    .login-form input {
      width: 100%; padding: 12px 14px;
      border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
      background: rgba(255,255,255,0.03); color: rgba(255,255,255,0.9);
      font-family: 'Fredoka', sans-serif; font-size: 14px;
      outline: none; transition: border-color 0.2s, background 0.2s;
      margin-bottom: 14px;
    }
    .login-form input:focus {
      border-color: rgba(255,90,54,0.5); background: rgba(255,255,255,0.06);
    }
    .login-form input::placeholder { color: rgba(255,255,255,0.2); }

    .login-submit {
      width: 100%; padding: 13px 20px; border: none; border-radius: 12px;
      background: linear-gradient(135deg, #FF5A36, #ff8a65);
      color: white; font-family: 'Fredoka', sans-serif;
      font-size: 14px; font-weight: 600; cursor: pointer;
      transition: transform 0.15s, box-shadow 0.15s, opacity 0.2s;
      box-shadow: 0 4px 16px rgba(255,90,54,0.25); margin-top: 2px;
    }
    .login-submit:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 24px rgba(255,90,54,0.35);
    }
    .login-submit:active { transform: translateY(0); }
    .login-submit:disabled { opacity: 0.6; cursor: not-allowed; transform: none; }

    /* ── Feedback ── */
    .login-error {
      background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.2);
      border-radius: 10px; padding: 10px 14px; color: #fca5a5;
      font-size: 13px; margin-bottom: 16px; display: none; text-align: center;
    }
    .login-error.visible { display: block; }

    .login-loading {
      display: none; color: rgba(255,255,255,0.4);
      font-size: 13px; margin-top: 16px; text-align: center;
    }
    .login-loading.visible { display: block; }

    .login-footer { margin-top: 20px; font-size: 12px; }
    .login-footer a { color: rgba(255,255,255,0.25); text-decoration: none; }
    .login-footer a:hover { color: rgba(255,255,255,0.5); }

    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      display: inline-block; width: 14px; height: 14px;
      border: 2px solid rgba(255,255,255,0.15); border-top-color: rgba(255,255,255,0.5);
      border-radius: 50%; animation: spin 0.7s linear infinite;
      vertical-align: middle; margin-right: 6px;
    }
  </style>
</head>
<body>
  <div class="login-wrap">
    <img src="/yoinko-logo.svg" alt="yoinko" class="login-logo" onerror="this.style.display='none'">
    <div class="login-card">
      <h1>sign in to yoinko</h1>
      <p>your cloud knowledge base awaits</p>

      <div id="error" class="login-error"></div>

      <!-- Email / Password -->
      <form class="login-form" id="emailForm" onsubmit="return false;">
        <label for="email">email</label>
        <input type="email" id="email" placeholder="you@example.com" autocomplete="email" required>
        <label for="password">password</label>
        <input type="password" id="password" placeholder="••••••••" autocomplete="current-password" required>
        <button type="submit" class="login-submit" id="submitBtn">sign in</button>
      </form>

      <div class="login-divider">or</div>

      <!-- OAuth -->
      <button class="oauth-btn" onclick="signIn('github')">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>
        continue with GitHub
      </button>
      <button class="oauth-btn" onclick="signIn('google')">
        <svg viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 01-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
        continue with Google
      </button>

      <div id="loading" class="login-loading">
        <span class="spinner"></span> redirecting…
      </div>

      <div class="login-footer">
        <a href="https://yoinko.ai">&larr; back to yoinko.ai</a>
      </div>
    </div>
  </div>

  <script type="module">
    import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

    const supabase = createClient('${SUPABASE_URL}', '${SUPABASE_ANON_KEY}');
    const errorEl = document.getElementById('error');
    const loadingEl = document.getElementById('loading');
    const submitBtn = document.getElementById('submitBtn');

    // If we arrived here from a sign-out, destroy the Supabase client session first
    const params = new URLSearchParams(window.location.search);
    if (params.get('signed_out')) {
      await supabase.auth.signOut();
      // Clean URL without reload
      window.history.replaceState({}, '', '/auth/login');
    } else {
      // Check existing session (skip if we just signed out)
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.access_token) await setTokenAndRedirect(session);
    }

    // Email + password
    document.getElementById('emailForm').addEventListener('submit', async () => {
      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      if (!email || !password) return;

      errorEl.className = 'login-error';
      submitBtn.disabled = true;
      submitBtn.textContent = 'signing in…';

      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        errorEl.textContent = error.message;
        errorEl.className = 'login-error visible';
        submitBtn.disabled = false;
        submitBtn.textContent = 'sign in';
        return;
      }
      if (data.session?.access_token) await setTokenAndRedirect(data.session);
    });

    // OAuth
    window.signIn = async function(provider) {
      errorEl.className = 'login-error';
      loadingEl.className = 'login-loading visible';
      const { error } = await supabase.auth.signInWithOAuth({
        provider,
        options: { redirectTo: window.location.origin + '/auth/callback' },
      });
      if (error) {
        errorEl.textContent = error.message;
        errorEl.className = 'login-error visible';
        loadingEl.className = 'login-loading';
      }
    };

    async function setTokenAndRedirect(session) {
      const res = await fetch('/auth/set-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        }),
      });
      if (res.ok) window.location.href = '/';
    }
  </script>
</body>
</html>`;
}

// ── Callback page HTML ───────────────────────────────────────────────────────
function callbackPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>yoinko — authenticating…</title>
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

    /* ── Background ── */
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

    .orb {
      position: fixed; border-radius: 50%;
      filter: blur(80px); opacity: .35;
      animation: orbF 8s ease-in-out infinite alternate;
    }
    .o1 { width:300px;height:300px;background:rgba(255,90,54,.15);top:-100px;left:-80px;animation-duration:10s }
    .o2 { width:200px;height:200px;background:rgba(255,160,100,.1);bottom:-60px;right:-40px;animation-delay:3s;animation-duration:8s }
    @keyframes orbF {
      0% { transform: translate(0,0) scale(1); }
      100% { transform: translate(30px,-20px) scale(1.1); }
    }

    .noise {
      position: fixed; inset: 0; opacity: .03;
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
      pointer-events: none;
    }

    /* ── Content ── */
    .wrap {
      position: relative; z-index: 10;
      text-align: center; max-width: 400px; width: 90%;
      animation: wrapIn .5s ease-out;
    }
    @keyframes wrapIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }

    /* ── Mascot dancing ── */
    .mascot-stage {
      position: relative;
      width: 160px; height: 160px;
      margin: 0 auto 32px;
    }

    .mascot-glow {
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -50%);
      width: 120px; height: 120px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,90,54,.15) 0%, transparent 70%);
      animation: glowPulse 2s ease-in-out infinite;
    }
    @keyframes glowPulse {
      0%, 100% { transform: translate(-50%, -50%) scale(1); opacity: .5; }
      50% { transform: translate(-50%, -50%) scale(1.5); opacity: 1; }
    }

    .mascot-img {
      width: 130px; height: 130px;
      object-fit: contain;
      position: absolute;
      top: 50%; left: 50%;
      transform: translate(-50%, -55%);
      z-index: 2;
      animation: dance 1.4s ease-in-out infinite;
      filter: drop-shadow(0 8px 20px rgba(255,90,54,.12));
    }
    @keyframes dance {
      0%, 100% { transform: translate(-50%, -55%) rotate(0deg) scaleX(1); }
      12% { transform: translate(-50%, -68%) rotate(-5deg) scaleX(1); }
      24% { transform: translate(-50%, -55%) rotate(0deg) scaleX(1); }
      36% { transform: translate(-50%, -64%) rotate(4deg) scaleX(-1); }
      48% { transform: translate(-50%, -55%) rotate(0deg) scaleX(-1); }
      60% { transform: translate(-50%, -60%) rotate(-3deg) scaleX(1); }
      72% { transform: translate(-50%, -55%) rotate(0deg) scaleX(1); }
      84% { transform: translate(-50%, -58%) rotate(2deg) scaleX(-1); }
    }

    /* Shadow under mascot */
    .mascot-shadow {
      position: absolute;
      bottom: 8px; left: 50%;
      transform: translateX(-50%);
      width: 60px; height: 10px;
      background: rgba(0,0,0,.3);
      border-radius: 50%;
      filter: blur(5px);
      animation: shadowDance 1.4s ease-in-out infinite;
    }
    @keyframes shadowDance {
      0%, 100% { transform: translateX(-50%) scaleX(1); opacity: .3; }
      12% { transform: translateX(-50%) scaleX(.65); opacity: .15; }
      24% { transform: translateX(-50%) scaleX(1); opacity: .3; }
      36% { transform: translateX(-50%) scaleX(.72); opacity: .18; }
      48% { transform: translateX(-50%) scaleX(1); opacity: .3; }
      60% { transform: translateX(-50%) scaleX(.8); opacity: .22; }
    }

    /* Sparkles around mascot */
    .sparkle {
      position: absolute; width: 5px; height: 5px;
      border-radius: 50%;
      background: #FF5A36;
      animation: sparkle 2s ease-in-out infinite;
    }
    .s1 { top: 15%; left: 10%; animation-delay: 0s; }
    .s2 { top: 10%; right: 15%; animation-delay: .4s; }
    .s3 { top: 45%; left: 5%; animation-delay: .8s; }
    .s4 { top: 35%; right: 8%; animation-delay: 1.2s; }
    .s5 { top: 65%; left: 18%; animation-delay: .6s; }
    .s6 { top: 60%; right: 20%; animation-delay: 1s; }
    @keyframes sparkle {
      0%, 100% { opacity: 0; transform: scale(0); }
      50% { opacity: .6; transform: scale(1); }
    }

    /* ── Status ── */
    .status {
      font-size: 18px; font-weight: 600;
      color: rgba(255,255,255,.85);
      margin-bottom: 6px;
      letter-spacing: -.02em;
    }

    .sub-text {
      font-size: 13px;
      color: rgba(255,255,255,.3);
      margin-bottom: 4px;
    }

    /* Progress bar */
    .progress-track {
      width: 160px; height: 4px;
      background: rgba(255,255,255,.06);
      border-radius: 4px;
      margin: 20px auto 0;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%; width: 30%;
      background: linear-gradient(90deg, #FF5A36, #ff8a65);
      border-radius: 4px;
      animation: progressSweep 2s ease-in-out infinite;
    }
    @keyframes progressSweep {
      0% { width: 10%; margin-left: 0; }
      50% { width: 50%; margin-left: 25%; }
      100% { width: 10%; margin-left: 90%; }
    }

    .foot {
      margin-top: 28px; font-size: 11px;
      color: rgba(255,255,255,.12);
    }
    .foot a { color: rgba(255,255,255,.2); text-decoration: none; }
    .foot a:hover { color: rgba(255,255,255,.4); }

    /* ── Error state ── */
    .cb-error {
      display: none;
      margin-top: 24px;
      animation: wrapIn .3s ease-out;
    }
    .cb-error.visible { display: block; }

    .error-card {
      background: rgba(255,100,100,.06);
      border: 1px solid rgba(255,100,100,.12);
      border-radius: 18px;
      padding: 24px 28px;
    }
    .error-card p {
      color: rgba(255,180,180,.9);
      font-size: 14px; margin-bottom: 16px; line-height: 1.6;
    }
    .error-card a {
      display: inline-flex; align-items: center; gap: 6px;
      color: #FF5A36; text-decoration: none;
      font-size: 14px; font-weight: 500;
      padding: 8px 16px; border-radius: 10px;
      border: 1px solid rgba(255,90,54,.2);
      transition: all .2s;
    }
    .error-card a:hover {
      background: rgba(255,90,54,.08);
      border-color: rgba(255,90,54,.3);
    }
    .error-card a svg { width: 14px; height: 14px; }

    /* Success state */
    .mascot-img.success {
      animation: successBounce .5s ease-out forwards;
    }
    @keyframes successBounce {
      0% { transform: translate(-50%, -55%) scale(1); }
      50% { transform: translate(-50%, -70%) scale(1.1); }
      100% { transform: translate(-50%, -55%) scale(1); }
    }
  </style>
</head>
<body>
  <div class="bg-mesh"></div>
  <div class="orb o1"></div>
  <div class="orb o2"></div>
  <div class="noise"></div>

  <div class="wrap">
    <div class="mascot-stage" id="mascot-stage">
      <div class="mascot-glow"></div>
      <span class="sparkle s1"></span>
      <span class="sparkle s2"></span>
      <span class="sparkle s3"></span>
      <span class="sparkle s4"></span>
      <span class="sparkle s5"></span>
      <span class="sparkle s6"></span>
      <img src="/mascot.png" alt="yoinko" class="mascot-img" id="mascot" onerror="this.src='/yoinko-logo.svg';this.style.width='80px';this.style.height='80px'">
      <div class="mascot-shadow"></div>
    </div>

    <p class="status" id="status">authenticating…</p>
    <p class="sub-text" id="sub-text">hang tight, we're signing you in</p>
    <div class="progress-track" id="progress">
      <div class="progress-fill"></div>
    </div>

    <div id="error" class="cb-error">
      <div class="error-card">
        <p id="error-msg"></p>
        <a href="/auth/login">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9.707 16.707a1 1 0 01-1.414 0l-6-6a1 1 0 010-1.414l6-6a1 1 0 011.414 1.414L5.414 9H17a1 1 0 110 2H5.414l4.293 4.293a1 1 0 010 1.414z" clip-rule="evenodd"/></svg>
          try again
        </a>
      </div>
    </div>

    <div class="foot"><a href="https://yoinko.ai">yoinko.ai</a></div>
  </div>

  <script type="module">
    import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

    const supabase = createClient('${SUPABASE_URL}', '${SUPABASE_ANON_KEY}');
    const statusEl = document.getElementById('status');
    const subEl = document.getElementById('sub-text');
    let handled = false;

    // Handle PKCE code exchange (query param ?code=...)
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    if (code) {
      statusEl.textContent = 'exchanging code…';
      subEl.textContent = 'verifying your identity';
      try {
        const { data, error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) throw error;
        if (data.session?.access_token) {
          handled = true;
          await storeAndRedirect(data.session);
        }
      } catch (err) {
        showError(err.message || 'Code exchange failed');
      }
    }

    // Handle implicit flow (hash fragment #access_token=...)
    if (!handled) {
      const timeout = setTimeout(() => {
        if (!handled) showError('Authentication timed out. Please try again.');
      }, 10000);

      supabase.auth.onAuthStateChange(async (event, session) => {
        if (handled) return;
        if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.access_token) {
          handled = true;
          clearTimeout(timeout);
          await storeAndRedirect(session);
        }
      });
    }

    async function storeAndRedirect(session) {
      statusEl.textContent = 'almost there…';
      subEl.textContent = 'setting up your workspace';
      const res = await fetch('/auth/set-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
        }),
      });
      if (!res.ok) {
        showError('Failed to store session');
        return;
      }
      // Show success state
      statusEl.textContent = 'welcome back! \\u2728';
      subEl.textContent = '';
      document.getElementById('progress').style.display = 'none';
      const mascot = document.getElementById('mascot');
      mascot.style.animation = 'none';
      void mascot.offsetWidth; // force reflow
      mascot.classList.add('success');
      setTimeout(() => { window.location.href = '/'; }, 600);
    }

    function showError(msg) {
      document.getElementById('mascot-stage').style.display = 'none';
      document.getElementById('progress').style.display = 'none';
      subEl.style.display = 'none';
      statusEl.textContent = 'oops!';
      statusEl.style.color = 'rgba(255,150,150,.9)';
      document.getElementById('error').className = 'cb-error visible';
      document.getElementById('error-msg').textContent = msg;
    }
  </script>
</body>
</html>`;
}

export default router;
