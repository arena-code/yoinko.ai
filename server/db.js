// server/db.js  — SQLite initialization
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Ensure data directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'notas.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ──────────────────────────────────────────────────────────────────
// Pages are now stored as real files on disk via server/files.js
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

module.exports = { db, UPLOADS_DIR, DATA_DIR };
