// src/server/routes/projects.ts — Project management API
import express from 'express';
import { listProjects, createProject, renameProject, deleteProject, } from '../projects.js';
import { evictProjectDb } from '../db.js';
const router = express.Router();
/** Get tenant data dir from request (set by cloud-auth middleware) */
function dataDir(req) {
    return req.tenantDataDir;
}
// ── GET /api/projects ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
    try {
        res.json({ projects: listProjects(dataDir(req)) });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── POST /api/projects ────────────────────────────────────────────────────────
router.post('/', (req, res) => {
    try {
        const { name } = req.body;
        if (!name?.trim())
            return void res.status(400).json({ error: 'name is required' });
        const project = createProject(name.trim(), dataDir(req));
        res.status(201).json({ project });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── PATCH /api/projects/:id ───────────────────────────────────────────────────
router.patch('/:id', (req, res) => {
    try {
        const { name } = req.body;
        if (!name?.trim())
            return void res.status(400).json({ error: 'name is required' });
        const project = renameProject(req.params.id, name.trim(), dataDir(req));
        res.json({ project });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
// ── DELETE /api/projects/:id ──────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
    try {
        const id = req.params.id;
        const dd = dataDir(req);
        deleteProject(id, dd);
        evictProjectDb(id, dd);
        res.json({ success: true });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
export default router;
//# sourceMappingURL=projects.js.map