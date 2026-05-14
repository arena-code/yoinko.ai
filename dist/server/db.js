// src/server/db.ts — SQLite initialization (multi-project + multi-tenant aware)
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { DATA_DIR, getProjectDirs } from './projects.js';
import { CLOUD_ENABLED } from './tenant-context.js';
// ── Global DB (settings only — shared across all projects) ────────────────────
// In cloud mode, each tenant has their own global.db in their data dir.
// In self-hosted mode, there's a single global.db.
function createGlobalDb(dbDir) {
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'global.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS workspace_access (
      id         TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      user_email TEXT NOT NULL,
      role       TEXT NOT NULL CHECK(role IN ('read','write')),
      granted_at TEXT NOT NULL,
      UNIQUE(project_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS page_shares (
      token         TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL,
      page_id       TEXT NOT NULL,
      page_path     TEXT NOT NULL,
      password_hash TEXT,
      password_salt TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      UNIQUE(project_id, page_id)
    );

    CREATE INDEX IF NOT EXISTS idx_page_shares_token ON page_shares(token);

    CREATE TABLE IF NOT EXISTS asset_shares (
      token         TEXT PRIMARY KEY,
      project_id    TEXT NOT NULL,
      asset_id      TEXT NOT NULL,
      password_hash TEXT,
      password_salt TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      UNIQUE(project_id, asset_id)
    );

    CREATE INDEX IF NOT EXISTS idx_asset_shares_token ON asset_shares(token);
  `);
    // Seed defaults
    const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
    insertSetting.run('theme', 'dark');
    insertSetting.run('llm_provider', 'openai');
    insertSetting.run('llm_model', 'gpt-4o-mini');
    insertSetting.run('llm_api_key', '');
    insertSetting.run('llm_base_url', '');
    insertSetting.run('image_model', 'dall-e-3');
    return db;
}
// Self-hosted: initialize at boot
let _selfHostedGlobalDb = null;
function getSelfHostedGlobalDb() {
    if (!_selfHostedGlobalDb) {
        _selfHostedGlobalDb = createGlobalDb(DATA_DIR);
    }
    return _selfHostedGlobalDb;
}
// Cloud: per-tenant global db cache
const globalDbCache = new Map();
/**
 * Get the global settings DB.
 * In self-hosted mode: returns the singleton global.db
 * In cloud mode: returns the tenant's global.db (from req.tenantDataDir)
 */
export function getGlobalDb(dataDir) {
    if (!CLOUD_ENABLED || !dataDir) {
        return getSelfHostedGlobalDb();
    }
    if (!globalDbCache.has(dataDir)) {
        globalDbCache.set(dataDir, createGlobalDb(dataDir));
    }
    return globalDbCache.get(dataDir);
}
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
export function getProjectDb(projectId = 'default', dataDir) {
    const effectiveDataDir = dataDir || DATA_DIR;
    const cacheKey = `${effectiveDataDir}:${projectId}`;
    if (projectDbCache.has(cacheKey)) {
        return projectDbCache.get(cacheKey);
    }
    const { dbPath, uploadsDir } = getProjectDirs(projectId, effectiveDataDir);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
    const db = createProjectDb(dbPath);
    projectDbCache.set(cacheKey, db);
    return db;
}
export { DATA_DIR };
// Helper to invalidate cache if a project is deleted
export function evictProjectDb(projectId, dataDir) {
    const effectiveDataDir = dataDir || DATA_DIR;
    const cacheKey = `${effectiveDataDir}:${projectId}`;
    const db = projectDbCache.get(cacheKey);
    if (db) {
        db.close();
        projectDbCache.delete(cacheKey);
    }
}
//# sourceMappingURL=db.js.map