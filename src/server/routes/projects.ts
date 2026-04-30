// src/server/routes/projects.ts — Project management API
import express, { Request, Response } from 'express';
import {
  listProjects, createProject, renameProject, deleteProject,
} from '../projects.js';
import { evictProjectDb } from '../db.js';

const router = express.Router();

/** Get tenant data dir from request (set by cloud-auth middleware) */
function dataDir(req: Request): string | undefined {
  return (req as any).tenantDataDir;
}

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

export default router;
