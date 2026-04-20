// src/server/routes/projects.ts — Project management API
import express from 'express';
import { listProjects, createProject, renameProject, deleteProject, } from '../projects.js';
import { evictProjectDb } from '../db.js';
const router = express.Router();
// ── GET /api/projects ─────────────────────────────────────────────────────────
router.get('/', (_req, res) => {
    try {
        res.json({ projects: listProjects() });
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
        const project = createProject(name.trim());
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
        const project = renameProject(req.params.id, name.trim());
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
        deleteProject(id);
        evictProjectDb(id);
        res.json({ success: true });
    }
    catch (err) {
        res.status(400).json({ error: err.message });
    }
});
export default router;
//# sourceMappingURL=projects.js.map