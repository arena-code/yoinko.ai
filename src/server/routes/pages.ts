// src/server/routes/pages.ts
import express, { Request, Response } from 'express';
import path from 'path';
import { db } from '../db.js';
import {
  scanDir, flattenTree, readPage, writePage,
  createPage, createFolder, deletePath, renamePath,
  toId, fromId,
} from '../files.js';
import type { PageNode, Asset } from '../../shared/types.js';

const router = express.Router();

// ── GET /api/pages — full tree ────────────────────────────────────────────────
router.get('/', (_req: Request, res: Response) => {
  try {
    const tree = scanDir();
    res.json({ pages: tree });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/pages/flat — flat list ──────────────────────────────────────────
router.get('/flat', (_req: Request, res: Response) => {
  try {
    const tree = scanDir();
    const flat = flattenTree(tree);
    res.json({ pages: flat });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/pages/:id — single page with content ────────────────────────────
router.get('/:id', (req: Request, res: Response) => {
  try {
    const relPath = fromId(req.params.id as string);
    const tree = scanDir();
    const flat = flattenTree(tree);

    const page = flat.find(p => p.id === req.params.id as string);
    if (!page) return void res.status(404).json({ error: 'Page not found' });

    if (page.type === 'page') {
      try { page.content = readPage(relPath); } catch { page.content = ''; }
    }
    if (page.type === 'folder') {
      page.children = flat.filter(p => p.parent_id === page.id);
    }

    const assets = db.prepare<string, Omit<Asset, 'url'>>(
      `SELECT * FROM assets WHERE page_id = ? ORDER BY created_at DESC`
    ).all(page.id);
    page.assets = assets.map(a => ({ ...a, url: `/api/assets/${a.id}/file` }));

    res.json({ page });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/pages — create file or folder ───────────────────────────────────
router.post('/', (req: Request, res: Response) => {
  try {
    const { name, type, file_type, parent_id, content } = req.body as {
      name?: string;
      type?: 'page' | 'folder';
      file_type?: string;
      parent_id?: string;
      content?: string;
    };
    if (!name || !type) return void res.status(400).json({ error: 'name and type required' });

    let parentRelPath = '';
    if (parent_id) {
      try { parentRelPath = fromId(parent_id); } catch { /* root */ }
    }

    let relPath: string;
    if (type === 'folder') {
      relPath = parentRelPath ? `${parentRelPath}/${name}` : name;
      createFolder(relPath);
    } else {
      const ext = file_type ?? 'md';
      const filename = `${name}.${ext}`;
      relPath = parentRelPath ? `${parentRelPath}/${filename}` : filename;
      createPage(relPath, content ?? '');
    }

    const id = toId(relPath);
    const flat = flattenTree(scanDir());
    const page = flat.find(p => p.id === id);

    res.status(201).json({ page: page ?? { id, path: relPath, type, name } });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── PUT /api/pages/:id — update content or name ───────────────────────────────
router.put('/:id', (req: Request, res: Response) => {
  try {
    const relPath = fromId(req.params.id as string);
    const { content, name } = req.body as { content?: string; name?: string };

    if (name !== undefined) {
      const ext = path.extname(relPath);
      const newFileName = ext ? `${name}${ext}` : name;
      const newRelPath = renamePath(relPath, newFileName);
      const newId = toId(newRelPath);
      const flat = flattenTree(scanDir());
      const page = flat.find(p => p.id === newId);
      return void res.json({ page: page ?? { id: newId, path: newRelPath, name } });
    }

    if (content !== undefined) {
      writePage(relPath, content);
    }

    const flat = flattenTree(scanDir());
    const page = flat.find(p => p.id === req.params.id as string);
    res.json({ page: page ?? { id: req.params.id as string } });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── DELETE /api/pages/:id ─────────────────────────────────────────────────────
router.delete('/:id', (req: Request, res: Response) => {
  try {
    const relPath = fromId(req.params.id as string);
    deletePath(relPath);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
