// src/server/db.ts — SQLite initialization (multi-project aware)
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { DATA_DIR, getProjectDirs } from './projects.js';
// ── Global DB (settings only — shared across all projects) ────────────────────
const GLOBAL_DB_PATH = path.join(DATA_DIR, 'global.db');
fs.mkdirSync(DATA_DIR, { recursive: true });
export const globalDb = new Database(GLOBAL_DB_PATH);
globalDb.pragma('journal_mode = WAL');
globalDb.pragma('foreign_keys = ON');
globalDb.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
`);
// Seed defaults
const insertSetting = globalDb.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
insertSetting.run('theme', 'dark');
insertSetting.run('llm_provider', 'openai');
insertSetting.run('llm_model', 'gpt-4o-mini');
insertSetting.run('llm_api_key', '');
insertSetting.run('llm_base_url', '');
insertSetting.run('image_model', 'dall-e-3');
// ── Per-project DB cache ──────────────────────────────────────────────────────
const projectDbCache = new Map();
function createProjectDb(dbPath) {
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
    CREATE TABLE IF NOT EXISTS assets (
      id            TEXT PRIMARY KEY,
      page_id       TEXT,
      filename      TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type     TEXT,
      size          INTEGER,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id         TEXT PRIMARY KEY,
      page_id    TEXT,
      role       TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
    return db;
}
export function getProjectDb(projectId = 'default') {
    if (projectDbCache.has(projectId)) {
        return projectDbCache.get(projectId);
    }
    const { dbPath, uploadsDir } = getProjectDirs(projectId);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
    const db = createProjectDb(dbPath);
    projectDbCache.set(projectId, db);
    return db;
}
// Backwards compat: used by routes before they were project-aware
// (settings route still uses globalDb directly)
export { DATA_DIR };
// Helper to invalidate cache if a project is deleted
export function evictProjectDb(projectId) {
    const db = projectDbCache.get(projectId);
    if (db) {
        db.close();
        projectDbCache.delete(projectId);
    }
}
//# sourceMappingURL=db.js.map