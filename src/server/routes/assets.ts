// src/server/routes/assets.ts
import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { getProjectDb } from '../db.js';
import { getProjectDirs } from '../projects.js';
import type { Asset } from '../../shared/types.js';

const router = express.Router();
const now = () => new Date().toISOString();

function projectId(req: Request): string {
  return (req.headers['x-project-id'] as string) || 'default';
}

// Dynamic multer storage — destination resolved per-request from X-Project-Id
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    const { uploadsDir } = getProjectDirs(projectId(req));
    fs.mkdirSync(uploadsDir, { recursive: true });
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB max
  fileFilter: (_req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp|svg|pdf|mp4|mov|mp3|txt|md|html|csv|json/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype.split('/')[1]?.toLowerCase() ?? '');
    if (ext || mime) cb(null, true);
    else cb(new Error('File type not allowed'));
  },
});

// ── POST /api/assets/upload ───────────────────────────────────────────────────
router.post('/upload', upload.array('files', 20), (req: Request, res: Response) => {
  try {
    const { page_id } = req.body as { page_id?: string };
    const db = getProjectDb(projectId(req));
    const files = req.files as Express.Multer.File[];
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
    const db = getProjectDb(projectId(req));
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

// ── GET /api/assets/:id ───────────────────────────────────────────────────────
router.get('/:id', (req: Request, res: Response) => {
  try {
    const db = getProjectDb(projectId(req));
    const asset = db.prepare<string, Omit<Asset, 'url'>>(
      `SELECT * FROM assets WHERE id = ?`
    ).get(req.params.id as string);
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
    const { listProjects } = await import('../projects.js');
    const projects = listProjects();

    // Try current project first, then all others
    const searchOrder = [pid, ...projects.map(p => p.id).filter(id => id !== pid)];

    for (const searchPid of searchOrder) {
      const db = getProjectDb(searchPid);
      const asset = db.prepare<string, Omit<Asset, 'url'>>(
        `SELECT * FROM assets WHERE id = ?`
      ).get(req.params.id as string);

      if (asset) {
        const { uploadsDir } = getProjectDirs(searchPid);
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

// ── DELETE /api/assets/:id ────────────────────────────────────────────────────
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const pid = projectId(req);
    const db = getProjectDb(pid);
    const { uploadsDir } = getProjectDirs(pid);

    const asset = db.prepare<string, Omit<Asset, 'url'>>(
      `SELECT * FROM assets WHERE id = ?`
    ).get(req.params.id as string);
    if (!asset) return void res.status(404).json({ error: 'Asset not found' });

    const filePath = path.join(uploadsDir, asset.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    db.prepare(`DELETE FROM assets WHERE id = ?`).run(req.params.id as string);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
