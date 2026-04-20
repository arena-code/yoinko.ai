// src/server/routes/pages.ts
import express from 'express';
import path from 'path';
import { getProjectDb } from '../db.js';
import { getPagesDir } from '../files.js';
import { scanDir, flattenTree, readPage, writePage, createPage, createFolder, deletePath, renamePath, toId, fromId, } from '../files.js';
const router = express.Router();
function projectId(req) {
    return req.headers['x-project-id'] || 'default';
}
// ── GET /api/pages — full tree ────────────────────────────────────────────────
router.get('/', (req, res) => {
    try {
        const pagesDir = getPagesDir(projectId(req));
        const tree = scanDir(pagesDir);
        res.json({ pages: tree });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── GET /api/pages/flat — flat list ──────────────────────────────────────────
router.get('/flat', (req, res) => {
    try {
        const pagesDir = getPagesDir(projectId(req));
        const tree = scanDir(pagesDir);
        const flat = flattenTree(tree);
        res.json({ pages: flat });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── GET /api/pages/:id — single page with content ────────────────────────────
router.get('/:id', (req, res) => {
    try {
        const pid = projectId(req);
        const pagesDir = getPagesDir(pid);
        const db = getProjectDb(pid);
        const relPath = fromId(req.params.id);
        const tree = scanDir(pagesDir);
        const flat = flattenTree(tree);
        const page = flat.find(p => p.id === req.params.id);
        if (!page)
            return void res.status(404).json({ error: 'Page not found' });
        if (page.type === 'page') {
            try {
                page.content = readPage(pagesDir, relPath);
            }
            catch {
                page.content = '';
            }
        }
        if (page.type === 'folder') {
            page.children = flat.filter(p => p.parent_id === page.id);
        }
        const assets = db.prepare(`SELECT * FROM assets WHERE page_id = ? ORDER BY created_at DESC`).all(page.id);
        page.assets = assets.map(a => ({ ...a, url: `/api/assets/${a.id}/file` }));
        res.json({ page });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── POST /api/pages — create file or folder ───────────────────────────────────
router.post('/', (req, res) => {
    try {
        const pid = projectId(req);
        const pagesDir = getPagesDir(pid);
        const { name, type, file_type, parent_id, content } = req.body;
        if (!name || !type)
            return void res.status(400).json({ error: 'name and type required' });
        let parentRelPath = '';
        if (parent_id) {
            try {
                parentRelPath = fromId(parent_id);
            }
            catch { /* root */ }
        }
        let relPath;
        if (type === 'folder') {
            relPath = parentRelPath ? `${parentRelPath}/${name}` : name;
            createFolder(pagesDir, relPath);
        }
        else {
            const ext = file_type ?? 'md';
            const filename = `${name}.${ext}`;
            relPath = parentRelPath ? `${parentRelPath}/${filename}` : filename;
            createPage(pagesDir, relPath, content ?? '');
        }
        const id = toId(relPath);
        const flat = flattenTree(scanDir(pagesDir));
        const page = flat.find(p => p.id === id);
        res.status(201).json({ page: page ?? { id, path: relPath, type, name } });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── PUT /api/pages/:id — update content or name ───────────────────────────────
router.put('/:id', (req, res) => {
    try {
        const pid = projectId(req);
        const pagesDir = getPagesDir(pid);
        const relPath = fromId(req.params.id);
        const { content, name } = req.body;
        if (name !== undefined) {
            const ext = path.extname(relPath);
            const newFileName = ext ? `${name}${ext}` : name;
            const newRelPath = renamePath(pagesDir, relPath, newFileName);
            const newId = toId(newRelPath);
            const flat = flattenTree(scanDir(pagesDir));
            const page = flat.find(p => p.id === newId);
            return void res.json({ page: page ?? { id: newId, path: newRelPath, name } });
        }
        if (content !== undefined) {
            writePage(pagesDir, relPath, content);
        }
        const flat = flattenTree(scanDir(pagesDir));
        const page = flat.find(p => p.id === req.params.id);
        res.json({ page: page ?? { id: req.params.id } });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── DELETE /api/pages/:id ─────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
    try {
        const pid = projectId(req);
        const pagesDir = getPagesDir(pid);
        const relPath = fromId(req.params.id);
        deletePath(pagesDir, relPath);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
export default router;
//# sourceMappingURL=pages.js.map