// src/server/routes/assets.ts
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { db, UPLOADS_DIR } from '../db.js';
const router = express.Router();
const now = () => new Date().toISOString();
// Multer storage config
const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
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
        if (ext || mime)
            cb(null, true);
        else
            cb(new Error('File type not allowed'));
    },
});
// ── POST /api/assets/upload ───────────────────────────────────────────────────
router.post('/upload', upload.array('files', 20), (req, res) => {
    try {
        const { page_id } = req.body;
        const files = req.files;
        const results = [];
        for (const file of files) {
            const id = uuidv4();
            const ts = now();
            db.prepare(`INSERT INTO assets (id, page_id, filename, original_name, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, page_id ?? null, file.filename, file.originalname, file.mimetype, file.size, ts);
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
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── GET /api/assets — list (optional filter by page_id) ──────────────────────
router.get('/', (req, res) => {
    try {
        const { page_id } = req.query;
        let assets;
        if (page_id) {
            assets = db.prepare(`SELECT * FROM assets WHERE page_id = ? ORDER BY created_at DESC`).all(page_id);
        }
        else {
            assets = db.prepare(`SELECT * FROM assets ORDER BY created_at DESC`).all();
        }
        res.json({ assets: assets.map(a => ({ ...a, url: `/api/assets/${a.id}/file` })) });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── GET /api/assets/:id ───────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
    try {
        const asset = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id);
        if (!asset)
            return void res.status(404).json({ error: 'Asset not found' });
        res.json({ asset: { ...asset, url: `/api/assets/${asset.id}/file` } });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── GET /api/assets/:id/file — serve the actual file ─────────────────────────
router.get('/:id/file', (req, res) => {
    try {
        const asset = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id);
        if (!asset)
            return void res.status(404).send('Not found');
        const filePath = path.join(UPLOADS_DIR, asset.filename);
        if (!fs.existsSync(filePath))
            return void res.status(404).send('File missing');
        res.setHeader('Content-Type', asset.mime_type ?? 'application/octet-stream');
        res.setHeader('Content-Disposition', `inline; filename="${asset.original_name}"`);
        res.sendFile(filePath);
    }
    catch (err) {
        res.status(500).send(err.message);
    }
});
// ── DELETE /api/assets/:id ────────────────────────────────────────────────────
router.delete('/:id', (req, res) => {
    try {
        const asset = db.prepare(`SELECT * FROM assets WHERE id = ?`).get(req.params.id);
        if (!asset)
            return void res.status(404).json({ error: 'Asset not found' });
        const filePath = path.join(UPLOADS_DIR, asset.filename);
        if (fs.existsSync(filePath))
            fs.unlinkSync(filePath);
        db.prepare(`DELETE FROM assets WHERE id = ?`).run(req.params.id);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
export default router;
//# sourceMappingURL=assets.js.map