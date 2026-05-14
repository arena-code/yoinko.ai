// src/server/routes/pages.ts
import express from 'express';
import path from 'path';
import fs from 'fs';
import { getProjectDb } from '../db.js';
import { getPagesDir } from '../files.js';
import { scanDir, flattenTree, readPage, writePage, createPage, createFolder, deletePath, renamePath, toId, fromId, extensionForFileType, pageFileType, isPageLocked, setPageLocked, readFolderTodos, writeFolderTodos, } from '../files.js';
import { canCreateFolderInParent, canMovePageToParent } from '../../shared/page-depth.js';
import { projectId, dataDir } from '../request-helpers.js';
const router = express.Router();
// ── GET /api/pages — full tree ────────────────────────────────────────────────
router.get('/', (req, res) => {
    try {
        const pagesDir = getPagesDir(projectId(req), dataDir(req));
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
        const pagesDir = getPagesDir(projectId(req), dataDir(req));
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
        const dd = dataDir(req);
        const pagesDir = getPagesDir(pid, dd);
        const db = getProjectDb(pid, dd);
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
            page.locked = isPageLocked(pagesDir, relPath);
        }
        if (page.type === 'folder') {
            page.children = flat.filter(p => p.parent_id === page.id).map(child => {
                const assetCount = (db.prepare(`SELECT COUNT(*) as cnt FROM assets WHERE page_id = ?`).get(child.id))?.cnt ?? 0;
                return { ...child, asset_count: assetCount };
            });
            try {
                page.priority_todos = JSON.parse(readFolderTodos(pagesDir, relPath));
            }
            catch {
                page.priority_todos = [];
            }
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
        const pagesDir = getPagesDir(pid, dataDir(req));
        const { name, type, file_type, parent_id, content } = req.body;
        if (!name || !type)
            return void res.status(400).json({ error: 'name and type required' });
        const flatBeforeCreate = flattenTree(scanDir(pagesDir));
        let parentRelPath = '';
        if (parent_id) {
            try {
                parentRelPath = fromId(parent_id);
            }
            catch { /* root */ }
        }
        let relPath;
        if (type === 'folder') {
            if (!canCreateFolderInParent(parent_id ?? null, flatBeforeCreate)) {
                return void res.status(400).json({ error: 'Folders can only be nested one level deep' });
            }
            relPath = parentRelPath ? `${parentRelPath}/${name}` : name;
            createFolder(pagesDir, relPath);
        }
        else {
            const ext = extensionForFileType(file_type ?? 'md');
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
        const pagesDir = getPagesDir(pid, dataDir(req));
        const relPath = fromId(req.params.id);
        const { content, name } = req.body;
        if (isPageLocked(pagesDir, relPath)) {
            return void res.status(423).json({ error: 'File is locked' });
        }
        if (name !== undefined) {
            const existingFileType = pageFileType(path.basename(relPath));
            const newFileName = existingFileType ? `${name}.${extensionForFileType(existingFileType)}` : name;
            const newRelPath = renamePath(pagesDir, relPath, newFileName);
            const newId = toId(newRelPath);
            // If this is a folder rename (no extension), migrate asset page_ids:
            //   Case 1: assets attached directly to the renamed folder (page_id === oldId)
            //   Case 2: assets attached to pages/subfolders inside the renamed folder
            if (!existingFileType) {
                const db = getProjectDb(pid, dataDir(req));
                const oldId = toId(relPath);
                const oldPrefix = relPath + '/'; // e.g. "01 - Branding/"
                const newPrefix = newRelPath + '/'; // e.g. "Branding/"
                const allAssets = db.prepare(`SELECT id, page_id FROM assets WHERE page_id IS NOT NULL`).all();
                const updateStmt = db.prepare(`UPDATE assets SET page_id = ? WHERE id = ?`);
                for (const asset of allAssets) {
                    if (!asset.page_id)
                        continue;
                    try {
                        // Case 1: asset lives directly on the renamed folder
                        if (asset.page_id === oldId) {
                            updateStmt.run(newId, asset.id);
                            continue;
                        }
                        // Case 2: asset lives on a page/subfolder inside the renamed folder
                        const assetPath = Buffer.from(asset.page_id, 'base64url').toString('utf8');
                        if (assetPath.startsWith(oldPrefix)) {
                            const updatedPath = newPrefix + assetPath.slice(oldPrefix.length);
                            const updatedId = Buffer.from(updatedPath).toString('base64url');
                            updateStmt.run(updatedId, asset.id);
                        }
                    }
                    catch { /* skip malformed ids */ }
                }
            }
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
// ── PATCH /api/pages/:id/lock — lock/unlock page editing ─────────────────────
router.patch('/:id/lock', (req, res) => {
    try {
        const pid = projectId(req);
        const pagesDir = getPagesDir(pid, dataDir(req));
        const relPath = fromId(req.params.id);
        const { locked } = req.body;
        setPageLocked(pagesDir, relPath, !!locked);
        const flat = flattenTree(scanDir(pagesDir));
        const page = flat.find(p => p.id === req.params.id);
        if (page)
            page.locked = !!locked;
        res.json({ page: page ?? { id: req.params.id, path: relPath, locked: !!locked } });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── PUT /api/pages/:id/todos — folder priority to-do board ───────────────────
router.put('/:id/todos', (req, res) => {
    try {
        const pid = projectId(req);
        const dd = dataDir(req);
        const pagesDir = getPagesDir(pid, dd);
        const relPath = fromId(req.params.id);
        const flat = flattenTree(scanDir(pagesDir));
        const page = flat.find(p => p.id === req.params.id);
        if (!page || page.type !== 'folder') {
            return void res.status(400).json({ error: 'To-do boards can only be added to folders' });
        }
        const { todos } = req.body;
        const safeTodos = Array.isArray(todos)
            ? todos.filter(t => t && typeof t.id === 'string' && typeof t.text === 'string')
                .map(t => ({
                id: t.id,
                text: t.text,
                priority: t.priority === 'high' || t.priority === 'medium' || t.priority === 'low' ? t.priority : 'medium',
                done: !!t.done,
            }))
            : [];
        writeFolderTodos(pagesDir, relPath, JSON.stringify(safeTodos, null, 2));
        page.priority_todos = safeTodos;
        res.json({ page });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── DELETE /api/pages/:id ─────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
    try {
        const pid = projectId(req);
        const pagesDir = getPagesDir(pid, dataDir(req));
        const relPath = fromId(req.params.id);
        if (isPageLocked(pagesDir, relPath)) {
            return void res.status(423).json({ error: 'File is locked' });
        }
        deletePath(pagesDir, relPath);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── PUT /api/pages/:id/move — move to different parent folder ─────────────────
router.put('/:id/move', (req, res) => {
    try {
        const pid = projectId(req);
        const dd = dataDir(req);
        const pagesDir = getPagesDir(pid, dd);
        const relPath = fromId(req.params.id);
        if (isPageLocked(pagesDir, relPath)) {
            return void res.status(423).json({ error: 'File is locked' });
        }
        const { target_parent_id } = req.body;
        const flatBeforeMove = flattenTree(scanDir(pagesDir));
        if (!canMovePageToParent(req.params.id, target_parent_id ?? null, flatBeforeMove)) {
            return void res.status(400).json({ error: 'Folders can only be nested one level deep' });
        }
        // Resolve target directory (root or a specific folder)
        let targetDir = '';
        if (target_parent_id) {
            targetDir = fromId(target_parent_id);
        }
        const basename = path.basename(relPath);
        const newRelPath = targetDir ? `${targetDir}/${basename}` : basename;
        if (newRelPath === relPath) {
            return void res.json({ success: true }); // no-op
        }
        const srcAbs = path.join(pagesDir, relPath);
        const dstAbs = path.join(pagesDir, newRelPath);
        // Safety: make sure dst parent exists
        const dstParent = path.dirname(dstAbs);
        if (!path.resolve(dstParent).startsWith(path.resolve(pagesDir))) {
            return void res.status(400).json({ error: 'Invalid target' });
        }
        if (!fs.existsSync(srcAbs)) {
            return void res.status(404).json({ error: 'Source not found' });
        }
        fs.mkdirSync(dstParent, { recursive: true });
        fs.renameSync(srcAbs, dstAbs);
        // Migrate asset page_ids if this is a folder move
        const isFolder = fs.statSync(dstAbs).isDirectory();
        const db = getProjectDb(pid, dd);
        if (isFolder) {
            const oldId = toId(relPath); // base64url of the folder itself
            const newId = toId(newRelPath);
            const oldPrefix = relPath + '/'; // sub-page prefix (with trailing slash)
            const newPrefix = newRelPath + '/';
            const allAssets = db.prepare(`SELECT id, page_id FROM assets WHERE page_id IS NOT NULL`).all();
            const updateStmt = db.prepare(`UPDATE assets SET page_id = ? WHERE id = ?`);
            for (const asset of allAssets) {
                if (!asset.page_id)
                    continue;
                try {
                    // Case 1: asset lives directly on the moved folder
                    if (asset.page_id === oldId) {
                        updateStmt.run(newId, asset.id);
                        continue;
                    }
                    // Case 2: asset lives on a page/subfolder inside the moved folder
                    const assetPath = Buffer.from(asset.page_id, 'base64url').toString('utf8');
                    if (assetPath.startsWith(oldPrefix)) {
                        const updatedPath = newPrefix + assetPath.slice(oldPrefix.length);
                        updateStmt.run(Buffer.from(updatedPath).toString('base64url'), asset.id);
                    }
                }
                catch { /* skip malformed */ }
            }
        }
        else {
            // Single page moved — simple direct update
            const oldId = toId(relPath);
            const newId = toId(newRelPath);
            db.prepare(`UPDATE assets SET page_id = ? WHERE page_id = ?`).run(newId, oldId);
        }
        const flat = flattenTree(scanDir(pagesDir));
        const newId = toId(newRelPath);
        const page = flat.find(p => p.id === newId);
        res.json({ page: page ?? { id: newId, path: newRelPath } });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
export default router;
//# sourceMappingURL=pages.js.map