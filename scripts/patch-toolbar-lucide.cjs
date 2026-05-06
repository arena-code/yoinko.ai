#!/usr/bin/env node
// Replaces the toolbar HTML block in app.ts with clean data-lucide icons
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../src/client/app.ts');
let src = fs.readFileSync(file, 'utf8');

// The new toolbar HTML — using data-lucide attributes for all icons
// Lucide will replace <i data-lucide="name"> with proper SVGs at runtime
const NEW_TOOLBAR = `    <div class="wysiwyg-page">
      <div class="editor-toolbar" id="editor-toolbar" role="toolbar" aria-label="Formatting">

        <!-- History -->
        <button class="tb-btn" id="tb-undo" title="Undo (⌘Z)">
          <i data-lucide="undo-2"></i>
        </button>
        <button class="tb-btn" id="tb-redo" title="Redo (⌘⇧Z)">
          <i data-lucide="redo-2"></i>
        </button>

        <span class="tb-sep"></span>

        <!-- Heading dropdown -->
        <div class="tb-dropdown" id="tb-heading-wrap">
          <button class="tb-btn tb-dropdown-btn" id="tb-heading" title="Text style">
            <span class="tb-heading-label" id="tb-heading-label">Text</span>
            <i data-lucide="chevron-down" class="tb-caret"></i>
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

        <!-- Inline marks -->
        <button class="tb-btn" id="tb-bold" title="Bold (⌘B)">
          <i data-lucide="bold"></i>
        </button>
        <button class="tb-btn" id="tb-italic" title="Italic (⌘I)">
          <i data-lucide="italic"></i>
        </button>
        <button class="tb-btn" id="tb-underline" title="Underline (⌘U)">
          <i data-lucide="underline"></i>
        </button>
        <button class="tb-btn" id="tb-strike" title="Strikethrough">
          <i data-lucide="strikethrough"></i>
        </button>
        <button class="tb-btn" id="tb-code" title="Inline code">
          <i data-lucide="code"></i>
        </button>

        <span class="tb-sep"></span>

        <!-- Block nodes -->
        <button class="tb-btn" id="tb-bullet" title="Bullet list">
          <i data-lucide="list"></i>
        </button>
        <button class="tb-btn" id="tb-ordered" title="Numbered list">
          <i data-lucide="list-ordered"></i>
        </button>
        <button class="tb-btn" id="tb-task" title="Task list">
          <i data-lucide="list-checks"></i>
        </button>
        <button class="tb-btn" id="tb-blockquote" title="Blockquote">
          <i data-lucide="quote"></i>
        </button>
        <button class="tb-btn" id="tb-codeblock" title="Code block">
          <i data-lucide="terminal-square"></i>
        </button>

        <span class="tb-sep"></span>

        <!-- Link -->
        <div class="tb-dropdown" id="tb-link-wrap">
          <button class="tb-btn" id="tb-link" title="Link (⌘K)">
            <i data-lucide="link"></i>
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
          <i data-lucide="minus"></i>
        </button>

      </div>
      <div id="wysiwyg-editor" class="tiptap-host" spellcheck="true"></div>
      <div class="tiptap-hint">
        <span><kbd>**</kbd> bold</span>
        <span><kbd>*</kbd> italic</span>
        <span><kbd># </kbd> heading</span>
        <span><kbd>- </kbd> list</span>
        <span><kbd>[] </kbd> task</span>
        <span><kbd>> </kbd> quote</span>
        <span><kbd>\`\`\` </kbd> code</span>
      </div>`;

// Find and replace the section from <div class="wysiwyg-page"> to just before \${renderAssetsSection}
const START_MARKER = '    <div class="wysiwyg-page">';
const END_MARKER = '      ${renderAssetsSection(page)}';

const startIdx = src.indexOf(START_MARKER);
const endIdx = src.indexOf(END_MARKER);

if (startIdx === -1) { console.error('START not found'); process.exit(1); }
if (endIdx === -1) { console.error('END not found'); process.exit(1); }

src = src.slice(0, startIdx) + NEW_TOOLBAR + '\n      ' + src.slice(endIdx);
fs.writeFileSync(file, src, 'utf8');
console.log('✅ Toolbar replaced with data-lucide icons');
