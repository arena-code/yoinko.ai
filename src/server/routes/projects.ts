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
import { evictProjectDb, getGlobalDb } from '../db.js';
import { dataDir } from '../request-helpers.js';
import { posthog, getDistinctId } from '../posthog.js';
import { getWorkspaceLimit } from '../storage.js';
import { v4 as uuidv4 } from 'uuid';

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
    const dd = dataDir(req);
    let projects = listProjects(dd);

    // Non-owner members only see workspaces they've been granted access to
    if (CLOUD_ENABLED && !((req as any).isOwner ?? true)) {
      const user = (req as any).user;
      const db = getGlobalDb(dd);
      const rows = db.prepare<string, { project_id: string }>(
        'SELECT project_id FROM workspace_access WHERE user_id = ?'
      ).all(user.id);
      const accessible = new Set(rows.map(r => r.project_id));
      projects = projects.filter(p => accessible.has(p.id));
    }

    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

const CLOUD_ENABLED = process.env.YOINKO_CLOUD === 'true';

// ── POST /api/projects ────────────────────────────────────────────────────────
router.post('/', (req: Request, res: Response) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name?.trim()) return void res.status(400).json({ error: 'name is required' });

    const dd = dataDir(req);
    if (CLOUD_ENABLED) {
      const plan = (req as any).tenantPlan || 'basic';
      const wsLimit = getWorkspaceLimit(plan);
      const existing = listProjects(dd);
      if (isFinite(wsLimit) && existing.length >= wsLimit) {
        return void res.status(403).json({
          error: `Workspace limit reached. Your plan allows up to ${wsLimit} workspaces.`,
        });
      }
    }

    const project = createProject(name.trim(), dd);

    posthog?.capture({
      distinctId: getDistinctId(req),
      event: 'project_created',
      properties: { project_id: project.id },
    });

    res.status(201).json({ project });
  } catch (err) {
    posthog?.captureException(err, getDistinctId(req));
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

    posthog?.capture({
      distinctId: getDistinctId(req),
      event: 'project_deleted',
      properties: { project_id: id },
    });

    res.json({ success: true });
  } catch (err) {
    posthog?.captureException(err, getDistinctId(req));
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

// ── Workspace access — owner-only helpers ─────────────────────────────────────
function requireOwner(req: Request, res: Response): boolean {
  if (!CLOUD_ENABLED) return true;
  const isOwner = (req as any).isOwner ?? true;
  if (!isOwner) {
    res.status(403).json({ error: 'Only the workspace owner can manage access.' });
    return false;
  }
  return true;
}

// GET /api/projects/:id/access — list users with access to this workspace
router.get('/:id/access', (req: Request, res: Response) => {
  try {
    if (!requireOwner(req, res)) return;
    const db = getGlobalDb(dataDir(req));
    const members = db.prepare<string, { user_id: string; user_email: string; role: string; granted_at: string }>(
      'SELECT user_id, user_email, role, granted_at FROM workspace_access WHERE project_id = ? ORDER BY granted_at ASC'
    ).all(req.params.id as string);
    res.json({ members });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/projects/:id/access — grant one or more users access
// Accepts either a single { user_id, user_email, role } or an array of them.
router.post('/:id/access', (req: Request, res: Response) => {
  try {
    if (!requireOwner(req, res)) return;

    type Entry = { user_id: string; user_email: string; role: string };
    const body = req.body as Entry | Entry[];
    const entries: Entry[] = Array.isArray(body) ? body : [body];

    if (!entries.length) return void res.status(400).json({ error: 'no entries provided' });
    for (const e of entries) {
      if (!e.user_id || !e.user_email) return void res.status(400).json({ error: 'user_id and user_email are required' });
      if (e.role !== 'read' && e.role !== 'write') return void res.status(400).json({ error: 'role must be read or write' });
    }

    const db = getGlobalDb(dataDir(req));
    const stmt = db.prepare(
      `INSERT INTO workspace_access (id, project_id, user_id, user_email, role, granted_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(project_id, user_id) DO UPDATE SET role = excluded.role`
    );
    const now = new Date().toISOString();
    for (const e of entries) {
      stmt.run(uuidv4(), req.params.id as string, e.user_id, e.user_email, e.role, now);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /api/projects/:id/access/:userId — revoke access
router.delete('/:id/access/:userId', (req: Request, res: Response) => {
  try {
    if (!requireOwner(req, res)) return;
    const db = getGlobalDb(dataDir(req));
    db.prepare('DELETE FROM workspace_access WHERE project_id = ? AND user_id = ?')
      .run(req.params.id as string, req.params.userId as string);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
