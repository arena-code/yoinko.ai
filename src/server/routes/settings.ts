// src/server/routes/settings.ts
import express, { Request, Response } from 'express';
import { getGlobalDb } from '../db.js';
import type { Settings } from '../../shared/types.js';

const router = express.Router();

/** Get tenant data dir from request (set by cloud-auth middleware) */
function dataDir(req: Request): string | undefined {
  return (req as any).tenantDataDir;
}

// ── GET /api/settings ─────────────────────────────────────────────────────────
router.get('/', (req: Request, res: Response) => {
  try {
    const db = getGlobalDb(dataDir(req));
    const rows = db.prepare<[], { key: string; value: string }>(`SELECT key, value FROM settings`).all();
    const settings: Record<string, string> = {};
    rows.forEach(r => { settings[r.key] = r.value; });

    // Mask the API key — never send full value to client
    if (settings.llm_api_key && settings.llm_api_key.length > 8) {
      settings.llm_api_key_masked = '•'.repeat(settings.llm_api_key.length - 4) + settings.llm_api_key.slice(-4);
    }

    res.json({ settings });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── PUT /api/settings — update one or more settings ──────────────────────────
router.put('/', (req: Request, res: Response) => {
  try {
    const db = getGlobalDb(dataDir(req));
    const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    const updateMany = db.transaction((updates: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(updates)) {
        upsert.run(key, String(value ?? ''));
      }
    });
    updateMany(req.body as Record<string, unknown>);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/settings/:key ────────────────────────────────────────────────────
router.get('/:key', (req: Request, res: Response) => {
  try {
    const db = getGlobalDb(dataDir(req));
    const row = db.prepare<string, { value: string }>(
      `SELECT value FROM settings WHERE key = ?`
    ).get(req.params.key as string);
    if (!row) return void res.status(404).json({ error: 'Setting not found' });
    res.json({ key: req.params.key, value: row.value });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
