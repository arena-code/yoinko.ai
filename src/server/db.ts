// src/server/db.ts — SQLite initialization
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.join(__dirname, '..', '..', 'data');
export const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Ensure data directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export const db: Database.Database = new Database(path.join(DATA_DIR, 'notas.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────────────────
// Pages are stored as real files on disk via files.ts
// SQLite only stores: assets, settings, chat_messages
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

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id         TEXT PRIMARY KEY,
    page_id    TEXT,
    role       TEXT NOT NULL CHECK(role IN ('user','assistant')),
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`);

// Seed default settings if not present
const insertSetting = db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`);
insertSetting.run('theme', 'dark');
insertSetting.run('llm_provider', 'openai');
insertSetting.run('llm_model', 'gpt-4o-mini');
insertSetting.run('llm_api_key', '');
insertSetting.run('llm_base_url', '');
insertSetting.run('image_model', 'dall-e-3');
