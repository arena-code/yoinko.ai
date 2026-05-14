import crypto from 'crypto';
import express, { Request, Response } from 'express';
import {
  findAssetShareByToken,
  findPageShareByToken,
  getSharedAsset,
  readSharedAsset,
  readSharedPage,
  verifySharePassword,
  type PasswordShareRecord,
} from '../share-service.js';
import type { Asset, PageNode } from '../../shared/types.js';

const router = express.Router();
const SHARE_COOKIE_SECRET = process.env.YOINKO_SHARE_COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function cookieName(token: string): string {
  return `yoinko_share_${token}`;
}

function shareSignature(share: PasswordShareRecord): string {
  return crypto
    .createHmac('sha256', SHARE_COOKIE_SECRET)
    .update(`${share.token}:${share.password_hash || ''}`)
    .digest('base64url');
}

function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').map(part => {
    const [key, ...rest] = part.trim().split('=');
    return [key, decodeURIComponent(rest.join('='))];
  }).filter(([key]) => key));
}

function isUnlocked(req: Request, share: PasswordShareRecord): boolean {
  if (!share.password_hash) return true;
  const cookies = parseCookies(req);
  return cookies[cookieName(share.token)] === shareSignature(share);
}

function setUnlockedCookie(req: Request, res: Response, share: PasswordShareRecord, cookiePath: string): void {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.cookie(cookieName(share.token), shareSignature(share), {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: cookiePath,
  });
}

function pageShell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${esc(title)} - yoinko</title>
  <style>
    :root{--ink:#1a1a2e;--tomato:#ff5a36;--mustard:#f3bc2f;--paper:#fffdf7;--muted:#6f6f7c;--line:rgba(26,26,46,.16)}
    *{box-sizing:border-box} body{margin:0;background:linear-gradient(135deg,#fff8ee 0%,#fff 52%,#fff2ec 100%);color:var(--ink);font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55}
    .share-shell{min-height:100vh;display:flex;flex-direction:column}
    .share-topbar{height:76px;border-bottom:1.5px solid var(--line);background:rgba(255,253,247,.92);backdrop-filter:blur(10px);position:sticky;top:0;z-index:2}.share-topbar-inner{width:min(1440px,calc(100vw - 56px));height:100%;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:18px}
    .share-brand{display:inline-flex;align-items:center;gap:12px;font-weight:900;letter-spacing:.01em;text-decoration:none;color:var(--ink)}.share-logo{display:block;width:138px;height:auto}.share-brand-text{font-size:18px;font-weight:950}
    .share-pill{display:inline-flex;align-items:center;gap:7px;border:1.5px solid var(--line);background:white;border-radius:999px;padding:6px 10px;font-size:12px;font-weight:800;color:var(--muted)}
    .share-page{width:min(1440px,calc(100vw - 56px));margin:36px auto 56px;background:white;border:1.5px solid rgba(26,26,46,.18);box-shadow:6px 6px 0 rgba(26,26,46,.92);border-radius:10px;overflow:hidden}
    .share-header{position:relative;min-height:128px;padding:30px 178px 22px 38px;border-bottom:1.5px solid var(--line);background:linear-gradient(180deg,#fffdf8,#fff8ec)}h1{margin:0;font-size:34px;line-height:1.1;letter-spacing:0;font-weight:950}.share-meta{margin-top:8px;color:var(--muted);font-size:13px;font-weight:750}
    .share-content{padding:34px 38px 42px}.share-content h1,.share-content h2,.share-content h3{line-height:1.16;margin:1.2em 0 .45em}.share-content h1{font-size:30px}.share-content h2{font-size:24px}.share-content h3{font-size:19px}.share-content p{margin:.7em 0}.share-content a{color:var(--tomato);font-weight:800}.share-content img{max-width:100%;border-radius:8px;border:1px solid var(--line)}pre{overflow:auto;background:#191927;color:#fff;padding:14px;border-radius:8px}code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:#f4f1ea;border-radius:4px;padding:1px 4px}pre code{background:transparent;padding:0}
    table{border-collapse:collapse;width:100%;margin:18px 0;background:white}th,td{border:1px solid var(--line);padding:9px 10px;text-align:left;vertical-align:top}th{background:#fff5e9;font-weight:900}.kanban-share{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.kanban-lane{border:1.5px solid var(--line);border-radius:8px;background:#fffaf3}.kanban-lane h3{margin:0;padding:12px 14px;border-bottom:1px solid var(--line)}.kanban-card{margin:10px;padding:10px;border:1px solid var(--line);border-radius:7px;background:white}.diagram-node{border:1.5px solid var(--line);border-radius:8px;padding:10px;margin:8px 0;background:#fffaf3}
    .share-footer{margin-top:auto;border-top:1.5px solid var(--line);background:rgba(255,253,247,.86)}.share-footer-inner{width:min(1440px,calc(100vw - 56px));margin:0 auto;padding:22px 0 26px;display:flex;align-items:center;justify-content:space-between;gap:22px;color:var(--muted);font-size:13px;font-weight:750}.share-footer-logo{width:122px;height:auto;display:block;flex-shrink:0}.share-footer-left{display:flex;align-items:center;gap:16px;min-width:0}.share-footer-copy{display:flex;flex-direction:column;gap:2px}.share-footer-copy strong{color:var(--ink);font-size:14px;font-weight:900}.share-footer-copy span{color:var(--muted)}.share-footer-cta{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:8px 18px;border:2px solid var(--ink);border-radius:999px;background:var(--tomato);color:white;text-decoration:none;font-weight:900;box-shadow:3px 3px 0 var(--ink);white-space:nowrap;transition:transform .12s ease,box-shadow .12s ease,background .12s ease}.share-footer-cta:hover{background:#e84d2d;transform:translate(-1px,-1px);box-shadow:4px 4px 0 var(--ink)}
    .share-mascot{position:absolute;right:34px;top:18px;width:112px;height:92px;display:flex;align-items:flex-end;justify-content:center;overflow:hidden;border:1.5px solid rgba(26,26,46,.18);border-radius:12px;background:#fffdf7;box-shadow:4px 4px 0 rgba(26,26,46,.86);pointer-events:none;transform-origin:50% 92%;animation:shareMascotFloat 4.8s ease-in-out infinite}.share-mascot img{display:block;width:118px;max-width:none;height:auto;margin-bottom:-24px;filter:drop-shadow(0 5px 6px rgba(26,26,46,.16))}@keyframes shareMascotFloat{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(-6px) rotate(2deg)}}
    .password-wrap{min-height:100vh;display:grid;place-items:center;padding:24px}.password-card{width:min(420px,100%);background:white;border:1.5px solid rgba(26,26,46,.22);box-shadow:6px 6px 0 var(--ink);border-radius:10px;padding:24px}.password-card h1{font-size:24px}.password-card p{color:var(--muted)}.password-card label{display:block;font-size:12px;font-weight:900;text-transform:uppercase;margin:14px 0 6px}.password-card input{width:100%;border:1.5px solid rgba(26,26,46,.24);border-radius:8px;padding:11px 12px;font:inherit}.password-card button{margin-top:14px;width:100%;border:2px solid var(--ink);background:var(--tomato);color:white;border-radius:8px;padding:11px 14px;font-weight:900;box-shadow:3px 3px 0 var(--ink);cursor:pointer}.share-error{color:#b42318;font-size:13px;font-weight:800}
    iframe.shared-html{width:100%;height:72vh;border:0;background:white}
    .asset-share-card{display:grid;gap:18px}.asset-share-preview{min-height:360px;border:1.5px solid var(--line);border-radius:10px;background:#fffdf7;display:flex;align-items:center;justify-content:center;overflow:hidden}.asset-share-image{display:block;max-width:100%;max-height:72vh;border:0;border-radius:0}.asset-share-frame{width:100%;height:72vh;border:0;background:white}.asset-share-file{width:min(520px,100%);padding:28px;border:1.5px dashed rgba(26,26,46,.28);border-radius:10px;background:white;text-align:center}.asset-share-file-badge{display:inline-flex;align-items:center;justify-content:center;min-width:76px;height:56px;margin-bottom:12px;border:2px solid var(--ink);border-radius:8px;background:var(--mustard);box-shadow:4px 4px 0 var(--ink);font-weight:950;text-transform:uppercase}.asset-share-actions{display:flex;gap:10px;flex-wrap:wrap}.share-content .asset-share-button{display:inline-flex;align-items:center;justify-content:center;min-height:40px;padding:8px 16px;border:2px solid var(--ink);border-radius:999px;background:var(--tomato);color:white;text-decoration:none;font-weight:900;box-shadow:3px 3px 0 var(--ink)}.share-content .asset-share-button.secondary{background:white;color:var(--ink)}
    @media(max-width:760px){.share-header{padding-right:18px}.share-mascot{position:relative;right:auto;top:auto;width:86px;height:70px;margin-top:16px;box-shadow:3px 3px 0 rgba(26,26,46,.86)}.share-mascot img{width:92px;margin-bottom:-18px}}@media(max-width:640px){.share-topbar{height:64px}.share-topbar-inner{width:100%;padding:0 14px}.share-logo{width:112px}.share-pill{font-size:11px;padding:5px 8px}.share-page{width:100%;margin:0;border-left:0;border-right:0;border-radius:0;box-shadow:none}.share-header,.share-content{padding-left:18px;padding-right:18px}h1{font-size:26px}.share-footer-inner{width:100%;padding:18px;flex-direction:column;align-items:stretch}.share-footer-left{align-items:flex-start}.share-footer-cta{width:100%}}
  </style>
</head>
<body>${body}</body>
</html>`;
}

function renderPasswordPage(
  token: string,
  error = '',
  options: { actionPath?: string; itemLabel?: string; buttonLabel?: string } = {},
): string {
  const actionPath = options.actionPath ?? `/share/${encodeURIComponent(token)}/unlock`;
  const itemLabel = options.itemLabel ?? 'page';
  const buttonLabel = options.buttonLabel ?? 'Open Shared Page';
  return pageShell('Password required', `
    <main class="password-wrap">
      <form class="password-card" method="post" action="${esc(actionPath)}">
        <a class="share-brand" href="https://yoinko.ai" target="_blank" rel="noopener noreferrer">
          <img class="share-logo" src="/yoinko-logo.svg" alt="Yoinko">
        </a>
        <h1>Password required</h1>
        <p>This shared ${esc(itemLabel)} is protected. Enter the password to continue.</p>
        ${error ? `<div class="share-error">${esc(error)}</div>` : ''}
        <label for="share-password">Password</label>
        <input id="share-password" name="password" type="password" autocomplete="current-password" autofocus>
        <button type="submit">${esc(buttonLabel)}</button>
      </form>
    </main>
  `);
}

function rewriteAssetUrls(html: string, token: string): string {
  return html.replace(/(["'(])\/api\/assets\/([^"'()\/]+)\/file/g, `$1/share/${token}/assets/$2/file`);
}

function renderInlineMarkdown(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" rel="nofollow noopener noreferrer">$1</a>');
}

function renderMarkdown(markdown: string, token: string): string {
  const lines = rewriteAssetUrls(markdown || '', token).split(/\r?\n/);
  const out: string[] = [];
  let listOpen = false;
  let codeOpen = false;
  const codeLines: string[] = [];

  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (codeOpen) {
        out.push(`<pre><code>${esc(codeLines.join('\n'))}</code></pre>`);
        codeLines.length = 0;
        codeOpen = false;
      } else {
        closeList();
        codeOpen = true;
      }
      continue;
    }
    if (codeOpen) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      closeList();
      out.push(`<h${heading[1].length}>${renderInlineMarkdown(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    const list = line.match(/^\s*[-*]\s+(?:\[( |x|X)\]\s+)?(.+)$/);
    if (list) {
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      const checkbox = list[1] !== undefined
        ? `<input type="checkbox" disabled${list[1].toLowerCase() === 'x' ? ' checked' : ''}> `
        : '';
      out.push(`<li>${checkbox}${renderInlineMarkdown(list[2])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${renderInlineMarkdown(line)}</p>`);
  }
  closeList();
  if (codeOpen) out.push(`<pre><code>${esc(codeLines.join('\n'))}</code></pre>`);
  return out.join('\n');
}

function parseJson<T>(raw: string, fallback: T): T {
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function renderKanban(content: string): string {
  const doc = parseJson<{ tasks?: Array<{ title?: string; status?: string; priority?: string }>; columns?: Array<{ id: string; title: string }> }>(content, { tasks: [] });
  const columns = doc.columns?.length ? doc.columns : [
    { id: 'todo', title: 'To Do' },
    { id: 'doing', title: 'Doing' },
    { id: 'done', title: 'Done' },
  ];
  return `<div class="kanban-share">${columns.map(column => {
    const tasks = (doc.tasks || []).filter(task => (task.status || 'todo') === column.id);
    return `<section class="kanban-lane"><h3>${esc(column.title)}</h3>${tasks.length
      ? tasks.map(task => `<article class="kanban-card"><strong>${esc(task.title || 'Untitled')}</strong>${task.priority ? `<div class="share-meta">${esc(task.priority)}</div>` : ''}</article>`).join('')
      : '<div class="kanban-card share-meta">No tasks</div>'}</section>`;
  }).join('')}</div>`;
}

function renderSheet(content: string): string {
  const doc = parseJson<{ cells?: string[][]; worksheets?: Array<{ name?: string; cells?: string[][] }> }>(content, { cells: [[]] });
  const sheets = doc.worksheets?.length ? doc.worksheets : [{ name: 'Sheet 1', cells: doc.cells || [[]] }];
  return sheets.map(sheet => {
    const rows = (sheet.cells || [[]]).slice(0, 200);
    return `<h2>${esc(sheet.name || 'Sheet')}</h2><table>${rows.map((row, rowIndex) => `<tr>${row.map(cell => rowIndex === 0 ? `<th>${esc(String(cell ?? ''))}</th>` : `<td>${esc(String(cell ?? ''))}</td>`).join('')}</tr>`).join('')}</table>`;
  }).join('');
}

function renderDiagram(content: string): string {
  const doc = parseJson<{ nodes?: Array<{ data?: { label?: string }; position?: { x?: number; y?: number } }>; edges?: unknown[] }>(content, { nodes: [] });
  if (!doc.nodes?.length) return '<p class="share-meta">Empty diagram.</p>';
  return doc.nodes.map(node => `<div class="diagram-node"><strong>${esc(node.data?.label || 'Untitled node')}</strong></div>`).join('');
}

function renderSharedContent(page: PageNode, content: string, token: string): string {
  if (page.file_type === 'html') {
    return `<iframe class="shared-html" sandbox="allow-scripts allow-forms allow-popups allow-modals" srcdoc="${esc(rewriteAssetUrls(content || '<p>Empty page</p>', token))}"></iframe>`;
  }
  if (page.file_type === 'kanban') return renderKanban(content);
  if (page.file_type === 'sheet') return renderSheet(content);
  if (page.file_type === 'diagram') return renderDiagram(content);
  return renderMarkdown(content, token);
}

function renderSharedPage(payload: { page: PageNode; content: string; assets: Asset[] }, token: string): string {
  const title = payload.page.display_name || payload.page.name;
  return pageShell(title, `
    <div class="share-shell">
      <header class="share-topbar">
        <div class="share-topbar-inner">
          <a class="share-brand" href="https://yoinko.ai" target="_blank" rel="noopener noreferrer">
            <img class="share-logo" src="/yoinko-logo.svg" alt="Yoinko">
          </a>
          <span class="share-pill">Read-only shared page</span>
        </div>
      </header>
      <main class="share-page">
        <header class="share-header">
          <h1>${esc(title)}</h1>
          <div class="share-meta">${esc((payload.page.file_type || 'md').toUpperCase())} · shared read-only</div>
          <div class="share-mascot" aria-hidden="true"><img src="/mascot.svg" alt=""></div>
        </header>
        <article class="share-content">${renderSharedContent(payload.page, payload.content, token)}</article>
      </main>
      <footer class="share-footer">
        <div class="share-footer-inner">
          <div class="share-footer-left">
            <img class="share-footer-logo" src="/yoinko-logo.svg" alt="Yoinko">
            <div class="share-footer-copy">
              <strong>Shared read-only with Yoinko.</strong>
              <span>Build, organize, and publish your workspace.</span>
            </div>
          </div>
          <a class="share-footer-cta" href="https://yoinko.ai" target="_blank" rel="noopener noreferrer">Use yoinko.ai now!</a>
        </div>
      </footer>
    </div>
  `);
}

function formatBytes(size: number | null | undefined): string {
  if (!size || size < 0) return 'Unknown size';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let idx = 0;
  while (value >= 1024 && idx < units.length - 1) {
    value /= 1024;
    idx += 1;
  }
  return `${value >= 10 || idx === 0 ? Math.round(value) : value.toFixed(1)} ${units[idx]}`;
}

function fileExtension(name: string): string {
  const ext = name.split('.').pop()?.trim();
  if (!ext || ext === name) return 'file';
  return ext.slice(0, 8);
}

function assetKind(asset: Asset): 'image' | 'pdf' | 'video' | 'audio' | 'file' {
  const mime = asset.mime_type || '';
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf') return 'pdf';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

function renderSharedAssetPreview(asset: Asset, token: string): string {
  const fileUrl = `/share/assets/${encodeURIComponent(token)}/file`;
  const name = asset.original_name || asset.filename;
  switch (assetKind(asset)) {
    case 'image':
      return `<div class="asset-share-preview"><img class="asset-share-image" src="${fileUrl}" alt="${esc(name)}"></div>`;
    case 'pdf':
      return `<div class="asset-share-preview"><iframe class="asset-share-frame" src="${fileUrl}" title="${esc(name)}"></iframe></div>`;
    case 'video':
      return `<div class="asset-share-preview"><video class="asset-share-image" src="${fileUrl}" controls></video></div>`;
    case 'audio':
      return `<div class="asset-share-preview"><audio src="${fileUrl}" controls></audio></div>`;
    default:
      return `<div class="asset-share-preview">
        <div class="asset-share-file">
          <div class="asset-share-file-badge">${esc(fileExtension(name))}</div>
          <strong>${esc(name)}</strong>
          <p class="share-meta">This document is shared read-only. Open or download it to view the original file.</p>
        </div>
      </div>`;
  }
}

function renderSharedAssetPage(payload: { asset: Asset; filePath: string }, token: string): string {
  const title = payload.asset.original_name || payload.asset.filename;
  const fileUrl = `/share/assets/${encodeURIComponent(token)}/file`;
  return pageShell(title, `
    <div class="share-shell">
      <header class="share-topbar">
        <div class="share-topbar-inner">
          <a class="share-brand" href="https://yoinko.ai" target="_blank" rel="noopener noreferrer">
            <img class="share-logo" src="/yoinko-logo.svg" alt="Yoinko">
          </a>
          <span class="share-pill">Read-only shared file</span>
        </div>
      </header>
      <main class="share-page">
        <header class="share-header">
          <h1>${esc(title)}</h1>
          <div class="share-meta">${esc(payload.asset.mime_type || 'File')} · ${esc(formatBytes(payload.asset.size))} · shared read-only</div>
          <div class="share-mascot" aria-hidden="true"><img src="/mascot.svg" alt=""></div>
        </header>
        <article class="share-content">
          <div class="asset-share-card">
            ${renderSharedAssetPreview(payload.asset, token)}
            <div class="asset-share-actions">
              <a class="asset-share-button" href="${fileUrl}" target="_blank" rel="noopener noreferrer">Open file</a>
              <a class="asset-share-button secondary" href="${fileUrl}" download="${esc(title)}">Download</a>
            </div>
          </div>
        </article>
      </main>
      <footer class="share-footer">
        <div class="share-footer-inner">
          <div class="share-footer-left">
            <img class="share-footer-logo" src="/yoinko-logo.svg" alt="Yoinko">
            <div class="share-footer-copy">
              <strong>Shared read-only with Yoinko.</strong>
              <span>Build, organize, and publish your workspace.</span>
            </div>
          </div>
          <a class="share-footer-cta" href="https://yoinko.ai" target="_blank" rel="noopener noreferrer">Use yoinko.ai now!</a>
        </div>
      </footer>
    </div>
  `);
}

router.get('/assets/:token', (req: Request, res: Response) => {
  const token = req.params.token as string;
  const resolved = findAssetShareByToken(token);
  if (!resolved) return void res.status(404).send(pageShell('Not found', '<main class="password-wrap"><div class="password-card"><h1>Shared file not found</h1></div></main>'));
  if (!isUnlocked(req, resolved.share)) {
    return void res.status(401).send(renderPasswordPage(token, '', {
      actionPath: `/share/assets/${encodeURIComponent(token)}/unlock`,
      itemLabel: 'file',
      buttonLabel: 'Open Shared File',
    }));
  }
  try {
    res.send(renderSharedAssetPage(readSharedAsset(resolved), token));
  } catch {
    res.status(404).send(pageShell('Not found', '<main class="password-wrap"><div class="password-card"><h1>Shared file not found</h1></div></main>'));
  }
});

router.post('/assets/:token/unlock', (req: Request, res: Response) => {
  const token = req.params.token as string;
  const resolved = findAssetShareByToken(token);
  const actionPath = `/share/assets/${encodeURIComponent(token)}/unlock`;
  const passwordOptions = { actionPath, itemLabel: 'file', buttonLabel: 'Open Shared File' };
  if (!resolved) return void res.status(404).send(renderPasswordPage(token, 'Shared file not found.', passwordOptions));
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!verifySharePassword(password, resolved.share)) {
    return void res.status(401).send(renderPasswordPage(token, 'Incorrect password.', passwordOptions));
  }
  setUnlockedCookie(req, res, resolved.share, `/share/assets/${resolved.share.token}`);
  res.redirect(303, `/share/assets/${encodeURIComponent(token)}`);
});

router.get('/assets/:token/file', (req: Request, res: Response) => {
  const token = req.params.token as string;
  const resolved = findAssetShareByToken(token);
  if (!resolved) return void res.status(404).send('Not found');
  if (!isUnlocked(req, resolved.share)) return void res.status(401).send('Password required');
  try {
    const payload = readSharedAsset(resolved);
    res.setHeader('Content-Type', payload.asset.mime_type ?? 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${payload.asset.original_name}"`);
    res.sendFile(payload.filePath);
  } catch {
    res.status(404).send('Not found');
  }
});

router.get('/:token', (req: Request, res: Response) => {
  const token = req.params.token as string;
  const resolved = findPageShareByToken(token);
  if (!resolved) return void res.status(404).send(pageShell('Not found', '<main class="password-wrap"><div class="password-card"><h1>Shared page not found</h1></div></main>'));
  if (!isUnlocked(req, resolved.share)) return void res.status(401).send(renderPasswordPage(token));
  try {
    res.send(renderSharedPage(readSharedPage(resolved), token));
  } catch {
    res.status(404).send(pageShell('Not found', '<main class="password-wrap"><div class="password-card"><h1>Shared page not found</h1></div></main>'));
  }
});

router.post('/:token/unlock', (req: Request, res: Response) => {
  const token = req.params.token as string;
  const resolved = findPageShareByToken(token);
  if (!resolved) return void res.status(404).send(renderPasswordPage(token, 'Shared page not found.'));
  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  if (!verifySharePassword(password, resolved.share)) {
    return void res.status(401).send(renderPasswordPage(token, 'Incorrect password.'));
  }
  setUnlockedCookie(req, res, resolved.share, `/share/${resolved.share.token}`);
  res.redirect(303, `/share/${encodeURIComponent(token)}`);
});

router.get('/:token/assets/:assetId/file', (req: Request, res: Response) => {
  const token = req.params.token as string;
  const resolved = findPageShareByToken(token);
  if (!resolved) return void res.status(404).send('Not found');
  if (!isUnlocked(req, resolved.share)) return void res.status(401).send('Password required');
  const found = getSharedAsset(resolved, req.params.assetId as string);
  if (!found) return void res.status(404).send('Not found');
  res.setHeader('Content-Type', found.asset.mime_type ?? 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${found.asset.original_name}"`);
  res.sendFile(found.filePath);
});

export default router;
