// src/server/routes/settings.ts
import express from 'express';
import { getGlobalDb } from '../db.js';
import { dataDir } from '../request-helpers.js';
const router = express.Router();
// ── Helpers ───────────────────────────────────────────────────────────────────
function getSettingValue(db, key) {
    const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
    return row?.value ?? null;
}
function upsertSetting(db, key, value) {
    db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}
function getProfiles(db) {
    const raw = getSettingValue(db, 'llm_profiles');
    if (!raw)
        return [];
    try {
        return JSON.parse(raw);
    }
    catch {
        return [];
    }
}
function saveProfiles(db, profiles) {
    upsertSetting(db, 'llm_profiles', JSON.stringify(profiles));
}
/** Mask an API key for safe client display */
function maskKey(key) {
    if (!key || key.length <= 8)
        return key ? '••••••••' : '';
    return '•'.repeat(key.length - 4) + key.slice(-4);
}
// ── GET /api/settings ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
    try {
        const db = getGlobalDb(dataDir(req));
        const rows = db.prepare(`SELECT key, value FROM settings`).all();
        const settings = {};
        rows.forEach(r => { settings[r.key] = r.value; });
        // Mask the API key — never send full value to client
        if (settings.llm_api_key && settings.llm_api_key.length > 8) {
            settings.llm_api_key_masked = maskKey(settings.llm_api_key);
        }
        res.json({ settings });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── PUT /api/settings — update one or more settings ──────────────────────────
router.put('/', (req, res) => {
    try {
        const db = getGlobalDb(dataDir(req));
        const upsert = db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
        const updateMany = db.transaction((updates) => {
            for (const [key, value] of Object.entries(updates)) {
                upsert.run(key, String(value ?? ''));
            }
        });
        updateMany(req.body);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── GET /api/settings/profiles — list all LLM profiles (keys masked) ─────────
router.get('/profiles', (req, res) => {
    try {
        const db = getGlobalDb(dataDir(req));
        const profiles = getProfiles(db);
        const activeId = getSettingValue(db, 'llm_active_profile') || '';
        // Mask API keys before sending to client
        const masked = profiles.map(p => ({
            ...p,
            api_key_masked: maskKey(p.api_key),
            api_key: '', // never send raw key
        }));
        res.json({ profiles: masked, activeId });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── PUT /api/settings/profiles — create or update a profile ──────────────────
router.put('/profiles', (req, res) => {
    try {
        const db = getGlobalDb(dataDir(req));
        const incoming = req.body;
        if (!incoming.id || !incoming.name) {
            return void res.status(400).json({ error: 'id and name are required' });
        }
        const profiles = getProfiles(db);
        const idx = profiles.findIndex(p => p.id === incoming.id);
        if (idx >= 0) {
            // Update existing — preserve API key if not provided
            const existing = profiles[idx];
            profiles[idx] = {
                ...existing,
                name: incoming.name,
                provider: incoming.provider,
                model: incoming.model,
                base_url: incoming.base_url ?? '',
                image_model: incoming.image_model ?? 'dall-e-3',
                api_key: incoming.api_key || existing.api_key,
            };
        }
        else {
            // Create new
            profiles.push({
                id: incoming.id,
                name: incoming.name,
                provider: incoming.provider || 'openai',
                model: incoming.model || '',
                api_key: incoming.api_key || '',
                base_url: incoming.base_url || '',
                image_model: incoming.image_model || 'dall-e-3',
            });
        }
        saveProfiles(db, profiles);
        // If this is the first profile, auto-set as active
        if (profiles.length === 1) {
            upsertSetting(db, 'llm_active_profile', profiles[0].id);
        }
        res.json({ success: true, profile: { ...profiles.find(p => p.id === incoming.id), api_key: '' } });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── DELETE /api/settings/profiles/:id — delete a profile ─────────────────────
router.delete('/profiles/:id', (req, res) => {
    try {
        const db = getGlobalDb(dataDir(req));
        const profiles = getProfiles(db);
        const filtered = profiles.filter(p => p.id !== req.params.id);
        if (filtered.length === profiles.length) {
            return void res.status(404).json({ error: 'Profile not found' });
        }
        saveProfiles(db, filtered);
        // If the deleted profile was active, clear or reassign
        const activeId = getSettingValue(db, 'llm_active_profile');
        if (activeId === req.params.id) {
            upsertSetting(db, 'llm_active_profile', filtered[0]?.id ?? '');
        }
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── PUT /api/settings/profiles/active — set the active profile ───────────────
router.put('/profiles/active', (req, res) => {
    try {
        const { id } = req.body;
        if (!id)
            return void res.status(400).json({ error: 'id is required' });
        const db = getGlobalDb(dataDir(req));
        const profiles = getProfiles(db);
        if (!profiles.find(p => p.id === id)) {
            return void res.status(404).json({ error: 'Profile not found' });
        }
        upsertSetting(db, 'llm_active_profile', id);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── GET /api/settings/templates — list all MD templates ──────────────────────
router.get('/templates', (req, res) => {
    try {
        const db = getGlobalDb(dataDir(req));
        const raw = getSettingValue(db, 'md_templates');
        const templates = raw ? JSON.parse(raw) : [];
        res.json({ templates });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── PUT /api/settings/templates — create or update a template ────────────────
router.put('/templates', (req, res) => {
    try {
        const db = getGlobalDb(dataDir(req));
        const incoming = req.body;
        if (!incoming.id || !incoming.name) {
            return void res.status(400).json({ error: 'id and name are required' });
        }
        const raw = getSettingValue(db, 'md_templates');
        const templates = raw ? JSON.parse(raw) : [];
        const idx = templates.findIndex(t => t.id === incoming.id);
        if (idx >= 0) {
            templates[idx] = incoming;
        }
        else {
            templates.push(incoming);
        }
        upsertSetting(db, 'md_templates', JSON.stringify(templates));
        res.json({ success: true, template: incoming });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── DELETE /api/settings/templates/:id — delete a template ───────────────────
router.delete('/templates/:id', (req, res) => {
    try {
        const db = getGlobalDb(dataDir(req));
        const raw = getSettingValue(db, 'md_templates');
        const templates = raw ? JSON.parse(raw) : [];
        const filtered = templates.filter(t => t.id !== req.params.id);
        upsertSetting(db, 'md_templates', JSON.stringify(filtered));
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// ── GET /api/settings/:key ────────────────────────────────────────────────────
router.get('/:key', (req, res) => {
    try {
        const db = getGlobalDb(dataDir(req));
        const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(req.params.key);
        if (!row)
            return void res.status(404).json({ error: 'Setting not found' });
        res.json({ key: req.params.key, value: row.value });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
export default router;
//# sourceMappingURL=settings.js.map