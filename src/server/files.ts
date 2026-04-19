// src/server/files.ts — Filesystem-based page manager
// Pages live in data/pages/ as real .md and .html files
// Folders on disk = sidebar sections; no SQLite for page content

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { PageNode } from '../shared/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PAGES_DIR = path.join(__dirname, '..', '..', 'data', 'pages');

// Ensure pages directory exists, seed if empty
if (!fs.existsSync(PAGES_DIR)) {
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  seedInitialContent();
}

// ── Name parsing ──────────────────────────────────────────────────────────────
interface ParsedName {
  num: string | null;
  display_name: string;
}

function parseName(rawName: string): ParsedName {
  const match = rawName.match(/^(\d+)\s*[-–]\s*(.+)$/);
  if (match) {
    return { num: String(parseInt(match[1])).padStart(2, '0'), display_name: match[2].trim() };
  }
  return { num: null, display_name: rawName };
}

// ── ID encoding ───────────────────────────────────────────────────────────────
export function toId(relPath: string): string {
  return Buffer.from(relPath).toString('base64url');
}

export function fromId(id: string): string {
  try {
    return Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    throw new Error('Invalid page ID');
  }
}

// ── Security ──────────────────────────────────────────────────────────────────
function sanitizePath(relPath: string): string {
  const normalized = path.normalize(relPath).replace(/\\/g, '/');
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    throw new Error('Invalid path: path traversal detected');
  }
  return normalized;
}

// ── Directory scanner ─────────────────────────────────────────────────────────
export function scanDir(baseDir?: string, relDir?: string): PageNode[] {
  baseDir = baseDir ?? PAGES_DIR;
  relDir = relDir ?? '';

  const fullDir = relDir ? path.join(baseDir, relDir) : baseDir;
  if (!fs.existsSync(fullDir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(fullDir, { withFileTypes: true });
  } catch {
    return [];
  }

  // Sort numerically by prefix, then alphabetically
  entries.sort((a, b) => {
    const aNum = (a.name.match(/^(\d+)/) ?? [])[1];
    const bNum = (b.name.match(/^(\d+)/) ?? [])[1];
    if (aNum && bNum) return parseInt(aNum) - parseInt(bNum);
    if (aNum) return -1;
    if (bNum) return 1;
    return a.name.localeCompare(b.name);
  });

  const items: PageNode[] = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'node_modules') continue;

    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    const fullPath = path.join(baseDir, relPath);

    if (entry.isDirectory()) {
      const children = scanDir(baseDir, relPath);
      const { num, display_name } = parseName(entry.name);
      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { continue; }

      items.push({
        id: toId(relPath),
        path: relPath,
        name: entry.name,
        display_name,
        num,
        type: 'folder',
        children,
        child_count: children.length,
        created_at: stat.birthtime.toISOString(),
        updated_at: stat.mtime.toISOString(),
      });
    } else if (entry.name.endsWith('.md') || entry.name.endsWith('.html')) {
      const ext: 'md' | 'html' = entry.name.endsWith('.md') ? 'md' : 'html';
      const baseName = entry.name.replace(/\.(md|html)$/, '');
      const { num, display_name } = parseName(baseName);
      let stat: fs.Stats;
      try { stat = fs.statSync(fullPath); } catch { continue; }

      items.push({
        id: toId(relPath),
        path: relPath,
        name: entry.name,
        display_name,
        num,
        type: 'page',
        file_type: ext,
        child_count: 0,
        created_at: stat.birthtime.toISOString(),
        updated_at: stat.mtime.toISOString(),
      });
    }
  }

  return items;
}

// ── Flatten tree to array ─────────────────────────────────────────────────────
export function flattenTree(tree: PageNode[], parentId: string | null = null): PageNode[] {
  const result: PageNode[] = [];
  for (const item of tree) {
    const { children, ...rest } = item;
    result.push({ ...rest, parent_id: parentId });
    if (children && children.length) {
      result.push(...flattenTree(children, item.id));
    }
  }
  return result;
}

// ── File operations ───────────────────────────────────────────────────────────
export function readPage(relPath: string): string {
  const safe = sanitizePath(relPath);
  const fullPath = path.join(PAGES_DIR, safe);
  if (!fs.existsSync(fullPath)) throw new Error('File not found: ' + relPath);
  return fs.readFileSync(fullPath, 'utf8');
}

export function writePage(relPath: string, content: string): void {
  const safe = sanitizePath(relPath);
  const fullPath = path.join(PAGES_DIR, safe);
  if (!fs.existsSync(fullPath)) throw new Error('File not found: ' + relPath);
  fs.writeFileSync(fullPath, content, 'utf8');
}

export function createPage(relPath: string, content: string = ''): void {
  const safe = sanitizePath(relPath);
  const fullPath = path.join(PAGES_DIR, safe);
  if (fs.existsSync(fullPath)) throw new Error('File already exists');
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

export function createFolder(relPath: string): void {
  const safe = sanitizePath(relPath);
  const fullPath = path.join(PAGES_DIR, safe);
  if (fs.existsSync(fullPath)) throw new Error('Folder already exists');
  fs.mkdirSync(fullPath, { recursive: true });
}

export function deletePath(relPath: string): void {
  const safe = sanitizePath(relPath);
  const fullPath = path.join(PAGES_DIR, safe);
  if (!fs.existsSync(fullPath)) throw new Error('Not found');
  const stat = fs.statSync(fullPath);
  if (stat.isDirectory()) {
    fs.rmSync(fullPath, { recursive: true, force: true });
  } else {
    fs.unlinkSync(fullPath);
  }
}

export function renamePath(oldRelPath: string, newName: string): string {
  const safeOld = sanitizePath(oldRelPath);
  const oldFull = path.join(PAGES_DIR, safeOld);
  if (!fs.existsSync(oldFull)) throw new Error('Not found');
  const newFull = path.join(path.dirname(oldFull), newName);
  fs.renameSync(oldFull, newFull);
  return path.join(path.dirname(safeOld), newName).replace(/\\/g, '/');
}

// ── Seed initial content ──────────────────────────────────────────────────────
function seedInitialContent(): void {
  const folder1 = path.join(PAGES_DIR, '1 - Getting Started');
  fs.mkdirSync(folder1, { recursive: true });

  fs.writeFileSync(path.join(folder1, '01 - Welcome.md'), `# Welcome to Notas

Notas is your open-source, AI-powered knowledge base.

## How it works

Notas is **filesystem-first** — pages are real files on disk:

- 📁 **Folders** in \`data/pages/\` become sidebar sections
- 📝 **.md files** become Markdown pages
- 🌐 **.html files** become HTML pages
- 🔢 **Prefix with numbers** to control order: \`01 - Page Name.md\`

You can manage files directly in \`data/pages/\` or through the app UI.

## Quick Start

1. Click **Edit** in the top right to edit this page
2. Use the **+ New Page** / **Folder** buttons to create content
3. Configure AI in **Settings** ⚙️ (gear icon)
4. Use the **+** floating button to add AI-generated sections
5. Open the 💬 chat to ask AI anything about a page

---

> **Tip:** Drop any \`.md\` or \`.html\` file directly into \`data/pages/\` and it will appear in the sidebar automatically.
`);

  const folder2 = path.join(PAGES_DIR, '2 - My Notes');
  fs.mkdirSync(folder2, { recursive: true });

  fs.writeFileSync(path.join(folder2, '01 - My First Note.md'), `# My First Note

Click **Edit** in the top bar to start writing.

## Ideas

- 

## Tasks

- [ ] 

---

*Created with Notas*
`);
}
