// src/server/projects.ts — Multi-project registry and migration
// In cloud mode, DATA_DIR is per-tenant (resolved from request).
// In self-hosted mode, DATA_DIR is a module-level constant (unchanged).
import fs from 'fs';
import path from 'path';
import { STATIC_DATA_DIR, CLOUD_ENABLED } from './tenant-context.js';
// Self-hosted: use the static data dir
export const DATA_DIR = STATIC_DATA_DIR;
// ── Registry helpers ──────────────────────────────────────────────────────────
function registryPath(dataDir) {
    return path.join(dataDir, 'projects.json');
}
export function listProjects(dataDir = DATA_DIR) {
    const rp = registryPath(dataDir);
    if (!fs.existsSync(rp))
        return [];
    try {
        return JSON.parse(fs.readFileSync(rp, 'utf8'));
    }
    catch {
        return [];
    }
}
function saveProjects(projects, dataDir = DATA_DIR) {
    fs.writeFileSync(registryPath(dataDir), JSON.stringify(projects, null, 2));
}
export function getProject(id, dataDir = DATA_DIR) {
    return listProjects(dataDir).find(p => p.id === id);
}
function slugify(name) {
    return name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'project';
}
function uniqueSlug(base, existing) {
    let slug = base;
    let n = 2;
    while (existing.includes(slug))
        slug = `${base}-${n++}`;
    return slug;
}
export function createProject(name, dataDir = DATA_DIR) {
    const projects = listProjects(dataDir);
    const id = uniqueSlug(slugify(name), projects.map(p => p.id));
    const project = { id, name, created_at: new Date().toISOString() };
    projects.push(project);
    saveProjects(projects, dataDir);
    ensureProjectDirs(id, dataDir);
    return project;
}
export function renameProject(id, name, dataDir = DATA_DIR) {
    const projects = listProjects(dataDir);
    const idx = projects.findIndex(p => p.id === id);
    if (idx === -1)
        throw new Error(`Project not found: ${id}`);
    projects[idx].name = name;
    saveProjects(projects, dataDir);
    return projects[idx];
}
export function deleteProject(id, dataDir = DATA_DIR) {
    if (id === 'default')
        throw new Error('Cannot delete the default project');
    const projects = listProjects(dataDir);
    const project = projects.find(p => p.id === id);
    if (!project)
        throw new Error(`Project not found: ${id}`);
    const { pagesDir } = getProjectDirs(id, dataDir);
    if (fs.existsSync(pagesDir)) {
        const entries = fs.readdirSync(pagesDir);
        if (entries.length > 0) {
            throw new Error('Project is not empty. Delete all pages first.');
        }
    }
    // Remove project directory
    const projectDir = path.join(dataDir, id);
    if (fs.existsSync(projectDir))
        fs.rmSync(projectDir, { recursive: true });
    saveProjects(projects.filter(p => p.id !== id), dataDir);
}
export function getProjectDirs(id, dataDir = DATA_DIR) {
    const projectDir = path.join(dataDir, id);
    return {
        pagesDir: path.join(projectDir, 'pages'),
        uploadsDir: path.join(projectDir, 'uploads'),
        dbPath: path.join(projectDir, 'yoinko.db'),
    };
}
function ensureProjectDirs(id, dataDir = DATA_DIR) {
    const { pagesDir, uploadsDir } = getProjectDirs(id, dataDir);
    fs.mkdirSync(pagesDir, { recursive: true });
    fs.mkdirSync(uploadsDir, { recursive: true });
}
// ── Startup migration ─────────────────────────────────────────────────────────
// Migrates old flat data/ structure → data/default/
// In cloud mode, this runs per-tenant on first login (handled by cloud-auth).
export function migrateOnStartup() {
    // Skip in cloud mode — migration is per-tenant on first login
    if (CLOUD_ENABLED) {
        console.log('  [projects] Cloud mode — skipping global migration');
        return;
    }
    const oldPagesDir = path.join(DATA_DIR, 'pages');
    const oldUploadsDir = path.join(DATA_DIR, 'uploads');
    const oldDbPath = path.join(DATA_DIR, 'notas.db');
    const projects = listProjects();
    // If registry is empty, we need to bootstrap
    if (projects.length === 0) {
        console.log('  [projects] First run — initialising default project…');
        const { pagesDir, uploadsDir, dbPath } = getProjectDirs('default');
        fs.mkdirSync(path.join(DATA_DIR, 'default'), { recursive: true });
        fs.mkdirSync(pagesDir, { recursive: true });
        fs.mkdirSync(uploadsDir, { recursive: true });
        // Move old pages/ → default/pages/
        if (fs.existsSync(oldPagesDir)) {
            fs.renameSync(oldPagesDir, pagesDir);
            console.log('  [projects] Migrated data/pages/ → data/default/pages/');
        }
        // Move old uploads/ → default/uploads/
        if (fs.existsSync(oldUploadsDir)) {
            // Merge into new dir (files may exist from fs.mkdirSync above)
            for (const file of fs.readdirSync(oldUploadsDir)) {
                fs.renameSync(path.join(oldUploadsDir, file), path.join(uploadsDir, file));
            }
            fs.rmdirSync(oldUploadsDir);
            console.log('  [projects] Migrated data/uploads/ → data/default/uploads/');
        }
        // Move old notas.db → default/yoinko.db
        if (fs.existsSync(oldDbPath)) {
            fs.renameSync(oldDbPath, dbPath);
            console.log('  [projects] Migrated data/notas.db → data/default/yoinko.db');
        }
        // Also move WAL/SHM if present
        for (const ext of ['-wal', '-shm']) {
            const oldWal = oldDbPath + ext;
            if (fs.existsSync(oldWal))
                fs.renameSync(oldWal, dbPath + ext);
        }
        // Write registry with default project
        saveProjects([{
                id: 'default',
                name: 'Default',
                created_at: new Date().toISOString(),
            }]);
        console.log('  [projects] Migration complete ✔');
    }
    else {
        // Ensure all registered projects have their directories
        for (const p of projects) {
            ensureProjectDirs(p.id);
        }
    }
}
//# sourceMappingURL=projects.js.map