#!/usr/bin/env node
// Patches the editor toolbar HTML in app.ts with clean Lucide-style icons
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../src/client/app.ts');
let src = fs.readFileSync(file, 'utf8');

const START = '      <div class="editor-toolbar" id="editor-toolbar" role="toolbar" aria-label="Formatting">';
const EDITOR_DIV = '      <div id="wysiwyg-editor"';

const startIdx = src.indexOf(START);
if (startIdx === -1) throw new Error('Toolbar start not found');

const editorIdx = src.indexOf(EDITOR_DIV, startIdx);
if (editorIdx === -1) throw new Error('Editor div not found');

const END_MARKER = '      </div>';
const beforeEditor = src.slice(startIdx, editorIdx);
const lastEnd = beforeEditor.lastIndexOf(END_MARKER);
const endIdx = startIdx + lastEnd + END_MARKER.length;

const NEW_TOOLBAR = `      <div class="editor-toolbar" id="editor-toolbar" role="toolbar" aria-label="Formatting">

        <!-- ── History ── -->
        <button class="tb-btn" id="tb-undo" title="Undo (⌘Z)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>
        </button>
        <button class="tb-btn" id="tb-redo" title="Redo (⌘⇧Z)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>
        </button>

        <span class="tb-sep"></span>

        <!-- ── Heading dropdown ── -->
        <div class="tb-dropdown" id="tb-heading-wrap">
          <button class="tb-btn tb-dropdown-btn" id="tb-heading" title="Text style">
            <span class="tb-heading-label" id="tb-heading-label">Text</span>
            <svg class="tb-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </button>
          <div class="tb-dropdown-menu" id="tb-heading-menu">
            <button class="tb-menu-item" data-level="1"><span class="tb-menu-badge">H1</span>Heading 1</button>
            <button class="tb-menu-item" data-level="2"><span class="tb-menu-badge">H2</span>Heading 2</button>
            <button class="tb-menu-item" data-level="3"><span class="tb-menu-badge">H3</span>Heading 3</button>
            <button class="tb-menu-item" data-level="4"><span class="tb-menu-badge">H4</span>Heading 4</button>
            <div class="tb-menu-divider"></div>
            <button class="tb-menu-item" data-level="0"><span class="tb-menu-badge">¶</span>Normal</button>
          </div>
        </div>

        <span class="tb-sep"></span>

        <!-- ── Inline marks ── -->
        <button class="tb-btn" id="tb-bold" title="Bold (⌘B)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/><path d="M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z"/></svg>
        </button>
        <button class="tb-btn" id="tb-italic" title="Italic (⌘I)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="4" x2="10" y2="4"/><line x1="14" y1="20" x2="5" y2="20"/><line x1="15" y1="4" x2="9" y2="20"/></svg>
        </button>
        <button class="tb-btn" id="tb-underline" title="Underline (⌘U)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4v6a6 6 0 0 0 12 0V4"/><line x1="4" y1="20" x2="20" y2="20"/></svg>
        </button>
        <button class="tb-btn" id="tb-strike" title="Strikethrough">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 4H9a3 3 0 0 0-2.83 4"/><path d="M14 12a4 4 0 0 1 0 8H6"/><line x1="4" y1="12" x2="20" y2="12"/></svg>
        </button>
        <button class="tb-btn" id="tb-code" title="Inline code">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        </button>

        <span class="tb-sep"></span>

        <!-- ── Block nodes ── -->
        <button class="tb-btn" id="tb-bullet" title="Bullet list">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4" cy="6" r="1.5" fill="currentColor" stroke="none"/><circle cx="4" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="4" cy="18" r="1.5" fill="currentColor" stroke="none"/></svg>
        </button>
        <button class="tb-btn" id="tb-ordered" title="Numbered list">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4" stroke-width="1.8"/><path d="M4 10h2" stroke-width="1.8"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1" stroke-width="1.8"/></svg>
        </button>
        <button class="tb-btn" id="tb-task" title="Task / checklist">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="6" height="6" rx="1"/><path d="m4.5 8 1.5 1.5 3-3"/><line x1="13" y1="8" x2="21" y2="8"/><rect x="3" y="13" width="6" height="6" rx="1"/><line x1="13" y1="16" x2="21" y2="16"/></svg>
        </button>
        <button class="tb-btn" id="tb-blockquote" title="Blockquote">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>
        </button>
        <button class="tb-btn" id="tb-codeblock" title="Code block">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/><line x1="12" y1="2" x2="12" y2="22" opacity="0.3"/></svg>
        </button>

        <span class="tb-sep"></span>

        <!-- ── Link ── -->
        <div class="tb-dropdown" id="tb-link-wrap">
          <button class="tb-btn" id="tb-link" title="Link (⌘K)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
          </button>
          <div class="tb-dropdown-menu tb-link-menu" id="tb-link-menu">
            <label class="tb-link-label">URL</label>
            <input class="tb-link-input" id="tb-link-input" type="url" placeholder="https://…" autocomplete="off" spellcheck="false" />
            <div class="tb-link-actions">
              <button class="tb-link-ok" id="tb-link-ok">Apply</button>
              <button class="tb-link-remove" id="tb-link-remove">Remove</button>
            </div>
          </div>
        </div>

        <button class="tb-btn" id="tb-hr" title="Horizontal rule">
          <svg viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="11" width="18" height="2" rx="1"/><rect x="3" y="6" width="6" height="1.5" rx="0.75"/><rect x="3" y="16.5" width="6" height="1.5" rx="0.75"/></svg>
        </button>

      </div>`;

src = src.slice(0, startIdx) + NEW_TOOLBAR + src.slice(endIdx);
fs.writeFileSync(file, src, 'utf8');
console.log('✅ Toolbar HTML patched successfully');
