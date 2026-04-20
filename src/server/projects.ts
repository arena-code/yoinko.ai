// src/server/projects.ts — Multi-project registry and migration
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, '..', '..', 'data');

export interface Project {
  id: string;        // slug, e.g. "default", "my-work"
  name: string;      // display name
  created_at: string;
}

const REGISTRY_PATH = path.join(DATA_DIR, 'projects.json');

// ── Registry helpers ──────────────────────────────────────────────────────────
export function listProjects(): Project[] {
  if (!fs.existsSync(REGISTRY_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8')) as Project[];
  } catch {
    return [];
  }
}

function saveProjects(projects: Project[]): void {
  fs.writeFileSync(REGISTRY_PATH, JSON.stringify(projects, null, 2));
}

export function getProject(id: string): Project | undefined {
  return listProjects().find(p => p.id === id);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'project';
}

function uniqueSlug(base: string, existing: string[]): string {
  let slug = base;
  let n = 2;
  while (existing.includes(slug)) slug = `${base}-${n++}`;
  return slug;
}

export function createProject(name: string): Project {
  const projects = listProjects();
  const id = uniqueSlug(slugify(name), projects.map(p => p.id));
  const project: Project = { id, name, created_at: new Date().toISOString() };
  projects.push(project);
  saveProjects(projects);
  ensureProjectDirs(id);
  return project;
}

export function renameProject(id: string, name: string): Project {
  const projects = listProjects();
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Project not found: ${id}`);
  projects[idx].name = name;
  saveProjects(projects);
  return projects[idx];
}

export function deleteProject(id: string): void {
  if (id === 'default') throw new Error('Cannot delete the default project');
  const projects = listProjects();
  const project = projects.find(p => p.id === id);
  if (!project) throw new Error(`Project not found: ${id}`);

  const { pagesDir } = getProjectDirs(id);
  if (fs.existsSync(pagesDir)) {
    const entries = fs.readdirSync(pagesDir);
    if (entries.length > 0) {
      throw new Error('Project is not empty. Delete all pages first.');
    }
  }

  // Remove project directory
  const projectDir = path.join(DATA_DIR, id);
  if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true });

  saveProjects(projects.filter(p => p.id !== id));
}

// ── Directory helpers ─────────────────────────────────────────────────────────
export interface ProjectDirs {
  pagesDir: string;
  uploadsDir: string;
  dbPath: string;
}

export function getProjectDirs(id: string): ProjectDirs {
  const projectDir = path.join(DATA_DIR, id);
  return {
    pagesDir: path.join(projectDir, 'pages'),
    uploadsDir: path.join(projectDir, 'uploads'),
    dbPath: path.join(projectDir, 'yoinko.db'),
  };
}

function ensureProjectDirs(id: string): void {
  const { pagesDir, uploadsDir } = getProjectDirs(id);
  fs.mkdirSync(pagesDir, { recursive: true });
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ── Startup migration ─────────────────────────────────────────────────────────
// Migrates old flat data/ structure → data/default/
export function migrateOnStartup(): void {
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
        fs.renameSync(
          path.join(oldUploadsDir, file),
          path.join(uploadsDir, file)
        );
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
      if (fs.existsSync(oldWal)) fs.renameSync(oldWal, dbPath + ext);
    }

    // Write registry with default project
    saveProjects([{
      id: 'default',
      name: 'Default',
      created_at: new Date().toISOString(),
    }]);

    console.log('  [projects] Migration complete ✔');
  } else {
    // Ensure all registered projects have their directories
    for (const p of projects) {
      ensureProjectDirs(p.id);
    }
  }
}
