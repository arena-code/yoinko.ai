// src/server/files.ts — Filesystem-based page manager (multi-project aware)
// Pages live in data/<project>/pages/ as real .md, .html, and JSON tool files
import fs from 'fs';
import path from 'path';
import { getProjectDirs } from './projects.js';
export const PAGE_FILE_EXTENSIONS = ['md', 'html', 'diagram.json', 'kanban.json', 'sheet.json'];
// ── Project pages dir ─────────────────────────────────────────────────────────
export function getPagesDir(projectId = 'default', dataDir) {
    const { pagesDir } = getProjectDirs(projectId, dataDir);
    if (!fs.existsSync(pagesDir)) {
        fs.mkdirSync(pagesDir, { recursive: true });
        seedInitialContent(pagesDir);
    }
    return pagesDir;
}
function parseName(rawName) {
    const match = rawName.match(/^(\d+)\s*[-–]\s*(.+)$/);
    if (match) {
        return { num: String(parseInt(match[1])).padStart(2, '0'), display_name: match[2].trim() };
    }
    return { num: null, display_name: rawName };
}
// ── ID encoding ───────────────────────────────────────────────────────────────
export function toId(relPath) {
    return Buffer.from(relPath).toString('base64url');
}
export function fromId(id) {
    try {
        return Buffer.from(id, 'base64url').toString('utf8');
    }
    catch {
        throw new Error('Invalid page ID');
    }
}
// ── Security ──────────────────────────────────────────────────────────────────
function sanitizePath(relPath) {
    const normalized = path.normalize(relPath).replace(/\\/g, '/');
    if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
        throw new Error('Invalid path: path traversal detected');
    }
    return normalized;
}
// ── Directory scanner ─────────────────────────────────────────────────────────
export function scanDir(baseDir, relDir) {
    relDir = relDir ?? '';
    const fullDir = relDir ? path.join(baseDir, relDir) : baseDir;
    if (!fs.existsSync(fullDir))
        return [];
    let entries;
    try {
        entries = fs.readdirSync(fullDir, { withFileTypes: true });
    }
    catch {
        return [];
    }
    // Sort numerically by prefix, then alphabetically
    entries.sort((a, b) => {
        const aNum = (a.name.match(/^(\d+)/) ?? [])[1];
        const bNum = (b.name.match(/^(\d+)/) ?? [])[1];
        if (aNum && bNum)
            return parseInt(aNum) - parseInt(bNum);
        if (aNum)
            return -1;
        if (bNum)
            return 1;
        return a.name.localeCompare(b.name);
    });
    const items = [];
    for (const entry of entries) {
        if (entry.name.startsWith('.'))
            continue;
        if (entry.name === 'node_modules')
            continue;
        const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
        const fullPath = path.join(baseDir, relPath);
        if (entry.isDirectory()) {
            const children = scanDir(baseDir, relPath);
            const { num, display_name } = parseName(entry.name);
            let stat;
            try {
                stat = fs.statSync(fullPath);
            }
            catch {
                continue;
            }
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
        }
        else {
            const fileType = pageFileType(entry.name);
            if (!fileType)
                continue;
            const baseName = entry.name.replace(/\.(md|html|diagram\.json|kanban\.json|sheet\.json)$/, '');
            const { num, display_name } = parseName(baseName);
            let stat;
            try {
                stat = fs.statSync(fullPath);
            }
            catch {
                continue;
            }
            items.push({
                id: toId(relPath),
                path: relPath,
                name: entry.name,
                display_name,
                num,
                type: 'page',
                file_type: fileType,
                child_count: 0,
                created_at: stat.birthtime.toISOString(),
                updated_at: stat.mtime.toISOString(),
                locked: isPageLocked(baseDir, relPath),
            });
        }
    }
    return items;
}
export function pageFileType(filename) {
    if (filename.endsWith('.diagram.json'))
        return 'diagram';
    if (filename.endsWith('.kanban.json'))
        return 'kanban';
    if (filename.endsWith('.sheet.json'))
        return 'sheet';
    if (filename.endsWith('.html'))
        return 'html';
    if (filename.endsWith('.md'))
        return 'md';
    return null;
}
export function extensionForFileType(fileType) {
    if (fileType === 'diagram')
        return 'diagram.json';
    if (fileType === 'kanban')
        return 'kanban.json';
    if (fileType === 'sheet')
        return 'sheet.json';
    if (fileType === 'html')
        return 'html';
    return 'md';
}
// ── Flatten tree to array ─────────────────────────────────────────────────────
export function flattenTree(tree, parentId = null) {
    const result = [];
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
export function readPage(pagesDir, relPath) {
    const safe = sanitizePath(relPath);
    const fullPath = path.join(pagesDir, safe);
    if (!fs.existsSync(fullPath))
        throw new Error('File not found: ' + relPath);
    return fs.readFileSync(fullPath, 'utf8');
}
export function isPageLocked(pagesDir, relPath) {
    const safe = sanitizePath(relPath);
    return fs.existsSync(path.join(pagesDir, `${safe}.lock`));
}
export function setPageLocked(pagesDir, relPath, locked) {
    const safe = sanitizePath(relPath);
    const fullPath = path.join(pagesDir, safe);
    if (!fs.existsSync(fullPath))
        throw new Error('File not found: ' + relPath);
    const lockPath = `${fullPath}.lock`;
    if (locked)
        fs.writeFileSync(lockPath, new Date().toISOString(), 'utf8');
    else if (fs.existsSync(lockPath))
        fs.unlinkSync(lockPath);
}
export function readFolderTodos(pagesDir, relPath) {
    const safe = sanitizePath(relPath);
    const todoPath = path.join(pagesDir, safe, '.yoinko-todos.json');
    if (!fs.existsSync(todoPath))
        return '[]';
    return fs.readFileSync(todoPath, 'utf8');
}
export function writeFolderTodos(pagesDir, relPath, todosJson) {
    const safe = sanitizePath(relPath);
    const folderPath = path.join(pagesDir, safe);
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory())
        throw new Error('Folder not found');
    fs.writeFileSync(path.join(folderPath, '.yoinko-todos.json'), todosJson, 'utf8');
}
export function writePage(pagesDir, relPath, content) {
    const safe = sanitizePath(relPath);
    const fullPath = path.join(pagesDir, safe);
    if (!fs.existsSync(fullPath))
        throw new Error('File not found: ' + relPath);
    if (isPageLocked(pagesDir, relPath))
        throw new Error('File is locked');
    fs.writeFileSync(fullPath, content, 'utf8');
}
export function createPage(pagesDir, relPath, content = '') {
    const safe = sanitizePath(relPath);
    const fullPath = path.join(pagesDir, safe);
    if (fs.existsSync(fullPath))
        throw new Error('File already exists');
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
}
export function createFolder(pagesDir, relPath) {
    const safe = sanitizePath(relPath);
    const fullPath = path.join(pagesDir, safe);
    if (fs.existsSync(fullPath))
        throw new Error('Folder already exists');
    fs.mkdirSync(fullPath, { recursive: true });
}
export function deletePath(pagesDir, relPath) {
    const safe = sanitizePath(relPath);
    const fullPath = path.join(pagesDir, safe);
    if (!fs.existsSync(fullPath))
        throw new Error('Not found');
    if (isPageLocked(pagesDir, relPath))
        throw new Error('File is locked');
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
        fs.rmSync(fullPath, { recursive: true, force: true });
    }
    else {
        fs.unlinkSync(fullPath);
    }
}
export function renamePath(pagesDir, oldRelPath, newName) {
    const safeOld = sanitizePath(oldRelPath);
    const oldFull = path.join(pagesDir, safeOld);
    if (!fs.existsSync(oldFull))
        throw new Error('Not found');
    if (isPageLocked(pagesDir, oldRelPath))
        throw new Error('File is locked');
    const newFull = path.join(path.dirname(oldFull), newName);
    fs.renameSync(oldFull, newFull);
    return path.join(path.dirname(safeOld), newName).replace(/\\/g, '/');
}
// ── Seed initial content ──────────────────────────────────────────────────────
function seedInitialContent(pagesDir) {
    const folder1 = path.join(pagesDir, '1 - Getting Started');
    fs.mkdirSync(folder1, { recursive: true });
    fs.writeFileSync(path.join(folder1, '01 - Welcome.md'), `# Welcome to yoınko

yoınko is your open-source, AI-powered knowledge base.

## How it works

yoınko is **filesystem-first** — pages are real files on disk:

- 📁 **Folders** become sidebar sections
- 📝 **.md files** become Markdown pages
- 🌐 **.html files** become HTML pages
- 🔢 **Prefix with numbers** to control order: \`01 - Page Name.md\`

## Quick Start

1. Click the folder name to start adding pages
2. Use the **+ New Page** / **Folder** buttons to create content
3. Configure AI in **Settings** ⚙️ (gear icon)
4. Open the 💬 chat to ask AI anything about a page

---

> **Tip:** You can have multiple projects — use the project switcher at the top of the sidebar.
`);
    const folder2 = path.join(pagesDir, '2 - My Notes');
    fs.mkdirSync(folder2, { recursive: true });
    fs.writeFileSync(path.join(folder2, '01 - My First Note.md'), `# My First Note

Click **Edit** in the top bar to start writing.

## Ideas

- 

## Tasks

- [ ] 

---

*Created with yoınko*
`);
}
//# sourceMappingURL=files.js.map