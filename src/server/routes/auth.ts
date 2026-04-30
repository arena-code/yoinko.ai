// src/server/routes/auth.ts — Cloud authentication routes
// Serves login page, callback handler, and token management.
// Active ONLY when YOINKO_CLOUD=true.

import { Router } from 'express';

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
  const { access_token } = req.body;
  if (!access_token) {
    res.status(400).json({ error: 'Missing access_token' });
    return;
  }

  res.cookie('yoinko_token', access_token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    path: '/',
  });

  res.json({ ok: true });
});

// ── POST /auth/logout — Clear ALL auth cookies ──────────────────────────────
router.post('/logout', (req, res) => {
  const isProduction = process.env.NODE_ENV === 'production';

  // Clear yoinko_token — must match exact options from set-token
  res.clearCookie('yoinko_token', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });

  // Clear any Supabase SSR cookies (sb-<ref>-auth-token and chunked variants)
  const cookieHeader = req.headers.cookie || '';
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
  const isProduction = process.env.NODE_ENV === 'production';

  res.clearCookie('yoinko_token', {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
  });

  const cookieHeader = req.headers.cookie || '';
  const cookieNames = cookieHeader.split(';').map(c => c.trim().split('=')[0]).filter(Boolean);
  for (const name of cookieNames) {
    if (name.match(/^sb-[^-]+-auth-token/)) {
      res.clearCookie(name, { path: '/' });
      res.clearCookie(name, { path: '/', domain: '.yoinko.ai' });
    }
  }

  res.redirect('/auth/login');
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

    // Check existing session
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.access_token) await setTokenAndRedirect(session.access_token);

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
      if (data.session?.access_token) await setTokenAndRedirect(data.session.access_token);
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

    async function setTokenAndRedirect(token) {
      const res = await fetch('/auth/set-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token }),
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
  <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Fredoka', sans-serif; background: #1a1a2e;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      color: rgba(255,255,255,0.5); font-size: 14px;
    }
    .cb-wrap { text-align: center; }
    .cb-logo {
      width: 100px; margin-bottom: 24px; opacity: 0.7;
      filter: brightness(0) invert(1);
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .spinner {
      display: inline-block; width: 20px; height: 20px;
      border: 2px solid rgba(255,255,255,0.1); border-top-color: #FF5A36;
      border-radius: 50%; animation: spin 0.7s linear infinite; margin-bottom: 16px;
    }
    .cb-error { color: #fca5a5; margin-top: 12px; display: none; }
    .cb-error.visible { display: block; }
    .cb-error a { color: #FF5A36; text-decoration: none; margin-top: 8px; display: inline-block; }
  </style>
</head>
<body>
  <div class="cb-wrap">
    <img src="/yoinko-logo.svg" alt="yoinko" class="cb-logo" onerror="this.style.display='none'">
    <div class="spinner"></div>
    <p id="status">authenticating…</p>
    <div id="error" class="cb-error">
      <p id="error-msg"></p>
      <a href="/auth/login">&larr; try again</a>
    </div>
  </div>

  <script type="module">
    import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

    const supabase = createClient('${SUPABASE_URL}', '${SUPABASE_ANON_KEY}');
    const statusEl = document.getElementById('status');
    let handled = false;

    // Handle PKCE code exchange (query param ?code=...)
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    if (code) {
      statusEl.textContent = 'exchanging code…';
      try {
        const { data, error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) throw error;
        if (data.session?.access_token) {
          handled = true;
          await storeAndRedirect(data.session.access_token);
        }
      } catch (err) {
        showError(err.message || 'Code exchange failed');
      }
    }

    // Handle implicit flow (hash fragment #access_token=...)
    // onAuthStateChange fires when the client auto-detects hash tokens
    if (!handled) {
      const timeout = setTimeout(() => {
        if (!handled) showError('Authentication timed out. Please try again.');
      }, 10000);

      supabase.auth.onAuthStateChange(async (event, session) => {
        if (handled) return;
        if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session?.access_token) {
          handled = true;
          clearTimeout(timeout);
          await storeAndRedirect(session.access_token);
        }
      });
    }

    async function storeAndRedirect(token) {
      statusEl.textContent = 'signing you in…';
      const res = await fetch('/auth/set-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token }),
      });
      if (!res.ok) {
        showError('Failed to store session');
        return;
      }
      window.location.href = '/';
    }

    function showError(msg) {
      document.querySelector('.spinner').style.display = 'none';
      statusEl.style.display = 'none';
      document.getElementById('error').className = 'cb-error visible';
      document.getElementById('error-msg').textContent = msg;
    }
  </script>
</body>
</html>`;
}

export default router;
