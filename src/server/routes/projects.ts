// src/server/routes/projects.ts — Project management API
import express, { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import {
  listProjects, createProject, renameProject, deleteProject,
  getProject, setProjectLogo, clearProjectLogo, getProjectLogoPath,
  reorderProjects, DATA_DIR,
} from '../projects.js';
import { evictProjectDb } from '../db.js';
import { dataDir } from '../request-helpers.js';

const router = express.Router();

// In-memory upload buffer for logos — small images, and we want to write the
// new file + update the registry atomically (delete old → write new) without
// multer's diskStorage racing the registry update.
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

// ── GET /api/projects ─────────────────────────────────────────────────────────
router.get('/', (req: Request, res: Response) => {
  try {
    res.json({ projects: listProjects(dataDir(req)) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/projects ────────────────────────────────────────────────────────
router.post('/', (req: Request, res: Response) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) return void res.status(400).json({ error: 'name is required' });
    const project = createProject(name.trim(), dataDir(req));
    res.status(201).json({ project });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── PUT /api/projects/order ──────────────────────────────────────────────────
// Persists a new order. Body: { ids: string[] } in desired order.
// Defined BEFORE PATCH/:id so "/order" doesn't get matched as an :id slug.
router.put('/order', (req: Request, res: Response) => {
  try {
    const { ids } = req.body as { ids?: unknown };
    if (!Array.isArray(ids) || ids.some(i => typeof i !== 'string')) {
      return void res.status(400).json({ error: 'ids must be a string[]' });
    }
    const projects = reorderProjects(ids as string[], dataDir(req) ?? DATA_DIR);
    res.json({ projects });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ── PATCH /api/projects/:id ───────────────────────────────────────────────────
router.patch('/:id', (req: Request, res: Response) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) return void res.status(400).json({ error: 'name is required' });
    const project = renameProject(req.params.id as string, name.trim(), dataDir(req));
    res.json({ project });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ── DELETE /api/projects/:id ──────────────────────────────────────────────────
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const dd = dataDir(req);
    deleteProject(id, dd);
    evictProjectDb(id, dd);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

// ── POST /api/projects/:id/logo ──────────────────────────────────────────────
// Upload a workspace logo. Replaces any existing logo. Multipart field "logo".
router.post('/:id/logo', logoUpload.single('logo'), (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const dd = dataDir(req) ?? DATA_DIR;
    const file = req.file;
    if (!file) return void res.status(400).json({ error: 'No file uploaded' });

    const project = getProject(id, dd);
    if (!project) return void res.status(404).json({ error: 'Project not found' });

    // Remove the previous logo file (if any) before writing the new one.
    if (project.logo) {
      const oldPath = path.join(dd, id, project.logo);
      if (fs.existsSync(oldPath)) {
        try { fs.unlinkSync(oldPath); } catch { /* ignore */ }
      }
    }

    const ext = (path.extname(file.originalname).toLowerCase() || '.png').replace(/[^.a-z0-9]/g, '');
    const filename = `logo-${Date.now()}${ext || '.png'}`;
    const projectDir = path.join(dd, id);
    fs.mkdirSync(projectDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, filename), file.buffer);

    const updated = setProjectLogo(id, filename, dd);
    res.json({ project: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── DELETE /api/projects/:id/logo ────────────────────────────────────────────
router.delete('/:id/logo', (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const dd = dataDir(req) ?? DATA_DIR;
    const project = getProject(id, dd);
    if (!project) return void res.status(404).json({ error: 'Project not found' });
    if (project.logo) {
      const filePath = path.join(dd, id, project.logo);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    const updated = clearProjectLogo(id, dd);
    res.json({ project: updated });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/projects/:id/logo ───────────────────────────────────────────────
// Streams the workspace logo image. Returns 404 if none is set.
router.get('/:id/logo', (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;
    const dd = dataDir(req);
    const filePath = getProjectLogoPath(id, dd);
    if (!filePath || !fs.existsSync(filePath)) {
      return void res.status(404).send('Not found');
    }
    res.sendFile(path.resolve(filePath));
  } catch (err) {
    res.status(500).send((err as Error).message);
  }
});

export default router;
