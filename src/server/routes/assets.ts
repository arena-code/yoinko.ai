// src/server/routes/assets.ts
import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getGlobalDb, getProjectDb } from '../db.js';
import { getProjectDirs, listProjects } from '../projects.js';
import type { Asset } from '../../shared/types.js';
import { projectId, dataDir } from '../request-helpers.js';
import { getTenantUsedBytes, getStorageLimit } from '../storage.js';
import {
  deleteAssetShare,
  getAssetShare,
  hashSharePassword,
  shareInfoFromRecord,
  upsertAssetShare,
} from '../share-service.js';

const CLOUD_ENABLED = process.env.YOINKO_CLOUD === 'true';

const router = express.Router();
const now = () => new Date().toISOString();

function assetShareUrl(req: Request, token: string): string {
  const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol;
  const host = req.get('host') || 'localhost';
  return `${protocol}://${host}/share/assets/${token}`;
}

function findProjectAsset(projectDb: ReturnType<typeof getProjectDb>, assetId: string): Omit<Asset, 'url'> | undefined {
  return projectDb.prepare<string, Omit<Asset, 'url'>>(
    `SELECT * FROM assets WHERE id = ?`
  ).get(assetId);
}

// Dynamic multer storage — destination resolved per-request from X-Project-Id
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const { uploadsDir } = getProjectDirs(projectId(req), dataDir(req));
    fs.mkdirSync(uploadsDir, { recursive: true });
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

// Allowed file extensions: media + documents + common code/text formats.
// Anything else → rejected with a friendly error.
const ALLOWED_EXTS = new Set([
  // Images & media
  'jpeg', 'jpg', 'png', 'gif', 'webp', 'svg', 'avif', 'bmp', 'ico',
  'mp4', 'mov', 'webm', 'mkv', 'mp3', 'wav', 'm4a', 'ogg', 'flac',
  // Documents
  'pdf', 'txt', 'md', 'markdown', 'html', 'htm', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf',
  'zip', 'tar', 'gz', '7z', 'rar',
  // Code & config files
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'php', 'cs', 'cpp', 'cc', 'c', 'h', 'hpp',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'css', 'scss', 'sass', 'less', 'styl',
  'sql', 'graphql', 'gql', 'proto',
  'env', 'ini', 'conf', 'cfg', 'lock',
  'dockerfile', 'makefile', 'gitignore', 'editorconfig',
]);

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/^\./, '');
    if (ALLOWED_EXTS.has(ext)) return cb(null, true);
    // Fallback: accept any text/* mime so plain-text files without a
    // recognised extension still work (e.g. dotfiles, README, LICENSE).
    if (file.mimetype.startsWith('text/')) return cb(null, true);
    cb(new Error(`File type not allowed: .${ext || 'unknown'}`));
  },
});

// Pre-flight quota check — rejects immediately if the tenant is already at the limit
function quotaCheck(req: Request, res: Response, next: NextFunction): void {
  if (!CLOUD_ENABLED) return next();
  const dd = dataDir(req);
  if (!dd) return next();
  const limit = getStorageLimit((req as any).tenantPlan || 'basic');
  const used = getTenantUsedBytes(dd);
  if (used >= limit) {
    res.status(413).json({ error: 'Storage limit reached. Delete files to free up space.' });
    return;
  }
  next();
}

// ── POST /api/assets/upload ───────────────────────────────────────────────────
router.post('/upload', quotaCheck, upload.array('files', 20), (req: Request, res: Response) => {
  try {
    const { page_id } = req.body as { page_id?: string };
    const dd = dataDir(req);
    const db = getProjectDb(projectId(req), dd);
    const files = req.files as Express.Multer.File[];

    // Post-upload quota check: if this batch pushed us over the limit, reject and clean up
    if (CLOUD_ENABLED && dd) {
      const limit = getStorageLimit((req as any).tenantPlan || 'basic');
      const batchSize = files.reduce((sum, f) => sum + f.size, 0);
      const usedAfter = getTenantUsedBytes(dd) + batchSize;
      if (usedAfter > limit) {
        for (const f of files) {
          try { fs.unlinkSync(f.path); } catch { /* ignore */ }
        }
        res.status(413).json({ error: 'Upload would exceed your 5 GB storage limit.' });
        return;
      }
    }

    const results: Asset[] = [];
    for (const file of files) {
      const id = uuidv4();
      const ts = now();
      db.prepare(
        `INSERT INTO assets (id, page_id, filename, original_name, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(id, page_id ?? null, file.filename, file.originalname, file.mimetype, file.size, ts);

      results.push({
        id,
        page_id: page_id ?? null,
        filename: file.filename,
        original_name: file.originalname,
        mime_type: file.mimetype,
        size: file.size,
        created_at: ts,
        url: `/api/assets/${id}/file`,
      });
    }

    res.status(201).json({ assets: results });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/assets — list (optional filter by page_id) ──────────────────────
router.get('/', (req: Request, res: Response) => {
  try {
    const { page_id } = req.query as { page_id?: string };
    const db = getProjectDb(projectId(req), dataDir(req));
    let assets: Omit<Asset, 'url'>[];
    if (page_id) {
      assets = db.prepare<string, Omit<Asset, 'url'>>(
        `SELECT * FROM assets WHERE page_id = ? ORDER BY created_at DESC`
      ).all(page_id);
    } else {
      assets = db.prepare<[], Omit<Asset, 'url'>>(
        `SELECT * FROM assets ORDER BY created_at DESC`
      ).all();
    }
    res.json({ assets: assets.map(a => ({ ...a, url: `/api/assets/${a.id}/file` })) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/assets/:id/share — current public share settings ───────────────
router.get('/:id/share', (req: Request, res: Response) => {
  try {
    const pid = projectId(req);
    const dd = dataDir(req);
    const assetId = req.params.id as string;
    const projectDb = getProjectDb(pid, dd);
    const asset = findProjectAsset(projectDb, assetId);
    if (!asset) return void res.status(404).json({ error: 'Asset not found' });

    const db = getGlobalDb(dd);
    const share = getAssetShare(db, pid, asset.id);
    res.json({ share: shareInfoFromRecord(share, share ? assetShareUrl(req, share.token) : undefined) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── PUT /api/assets/:id/share — publish/update public read-only asset ───────
router.put('/:id/share', (req: Request, res: Response) => {
  try {
    const pid = projectId(req);
    const dd = dataDir(req);
    const assetId = req.params.id as string;
    const projectDb = getProjectDb(pid, dd);
    const asset = findProjectAsset(projectDb, assetId);
    if (!asset) return void res.status(404).json({ error: 'Asset not found' });

    const { password_protected, password } = req.body as {
      password_protected?: boolean;
      password?: string;
    };
    const db = getGlobalDb(dd);
    const existing = getAssetShare(db, pid, asset.id);
    let passwordUpdate: { hash: string | null; salt: string | null } | undefined;

    if (password_protected) {
      const trimmed = typeof password === 'string' ? password.trim() : '';
      if (trimmed) {
        passwordUpdate = hashSharePassword(trimmed);
      } else if (!existing?.password_hash) {
        return void res.status(400).json({ error: 'Password required to protect this share' });
      }
    } else {
      passwordUpdate = { hash: null, salt: null };
    }

    const share = upsertAssetShare(db, pid, asset.id, passwordUpdate);
    res.json({ share: shareInfoFromRecord(share, assetShareUrl(req, share.token)) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── DELETE /api/assets/:id/share — unpublish asset ──────────────────────────
router.delete('/:id/share', (req: Request, res: Response) => {
  try {
    const pid = projectId(req);
    const dd = dataDir(req);
    const assetId = req.params.id as string;
    const projectDb = getProjectDb(pid, dd);
    const asset = findProjectAsset(projectDb, assetId);
    if (!asset) return void res.status(404).json({ error: 'Asset not found' });

    deleteAssetShare(getGlobalDb(dd), pid, asset.id);
    res.json({ share: { enabled: false } });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/assets/:id ───────────────────────────────────────────────────────
router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getProjectDb(projectId(req), dataDir(req));
    const asset = findProjectAsset(db, req.params.id as string);
    if (!asset) return void res.status(404).json({ error: 'Asset not found' });
    res.json({ asset: { ...asset, url: `/api/assets/${asset.id}/file` } });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/assets/:id/file — serve the actual file ─────────────────────────
// NOTE: asset lookup must search all projects' DBs since <img> tags don't
//       send X-Project-Id. We search the specified project first, then others.
router.get('/:id/file', async (req: Request, res: Response) => {
  try {
    const pid = projectId(req);
    const dd = dataDir(req);
    const projects = listProjects(dd);

    // Try current project first, then all others
    const searchOrder = [pid, ...projects.map(p => p.id).filter(id => id !== pid)];

    for (const searchPid of searchOrder) {
      const db = getProjectDb(searchPid, dd);
      const asset = db.prepare<string, Omit<Asset, 'url'>>(
        `SELECT * FROM assets WHERE id = ?`
      ).get(req.params.id as string);

      if (asset) {
        const { uploadsDir } = getProjectDirs(searchPid, dd);
        const filePath = path.join(uploadsDir, asset.filename);
        if (!fs.existsSync(filePath)) break;
        res.setHeader('Content-Type', asset.mime_type ?? 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${asset.original_name}"`);
        return void res.sendFile(filePath);
      }
    }

    res.status(404).send('Not found');
  } catch (err) {
    res.status(500).send((err as Error).message);
  }
});

// ── PUT /api/assets/:id/content — overwrite file content (code editor save) ──
router.put('/:id/content', (req: Request, res: Response) => {
  try {
    const pid = projectId(req);
    const dd = dataDir(req);
    const db = getProjectDb(pid, dd);
    const { uploadsDir } = getProjectDirs(pid, dd);

    const asset = findProjectAsset(db, req.params.id as string);
    if (!asset) return void res.status(404).json({ error: 'Asset not found' });

    const { content } = req.body as { content?: string };
    if (typeof content !== 'string') return void res.status(400).json({ error: 'content must be a string' });

    const filePath = path.join(uploadsDir, asset.filename);
    fs.writeFileSync(filePath, content, 'utf8');

    // Update size in DB
    const newSize = Buffer.byteLength(content, 'utf8');
    db.prepare(`UPDATE assets SET size = ? WHERE id = ?`).run(newSize, req.params.id as string);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── PATCH /api/assets/:id — update page_id (move asset to another page) ──────
router.patch('/:id', (req: Request, res: Response) => {
  try {
    const db = getProjectDb(projectId(req), dataDir(req));
    const { page_id } = req.body as { page_id?: string | null };
    db.prepare(`UPDATE assets SET page_id = ? WHERE id = ?`).run(page_id ?? null, req.params.id as string);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── DELETE /api/assets/:id ────────────────────────────────────────────────────
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const pid = projectId(req);
    const dd = dataDir(req);
    const db = getProjectDb(pid, dd);
    const { uploadsDir } = getProjectDirs(pid, dd);

    const asset = db.prepare<string, Omit<Asset, 'url'>>(
      `SELECT * FROM assets WHERE id = ?`
    ).get(req.params.id as string);
    if (!asset) return void res.status(404).json({ error: 'Asset not found' });

    const filePath = path.join(uploadsDir, asset.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    db.prepare(`DELETE FROM assets WHERE id = ?`).run(req.params.id as string);
    deleteAssetShare(getGlobalDb(dd), pid, asset.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
