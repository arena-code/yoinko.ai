// public/js/app.js — Main application logic (filesystem-backed)

// ── State ─────────────────────────────────────────────────────────────────────
const state = {
  pages: [],
  currentPageId: null,
  currentPage: null,
  theme: 'dark',
  chatOpen: false,
  chatMessages: [],
  chatStreaming: false,
  expandedFolders: new Set(),
  settings: {},
  wysiwyg: null,     // active Toast UI Editor instance
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const $$ = sel => document.querySelectorAll(sel);

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadSettings();
  applyTheme(state.theme);
  await loadPages();
  setupEventListeners();
  handleHashRoute();
  window.addEventListener('hashchange', handleHashRoute);
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  try {
    const { settings } = await api.getSettings();
    state.settings = settings;
    state.theme = settings.theme || 'dark';
  } catch {}
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  $('theme-icon').textContent = theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme() {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  api.saveSettings({ theme: next });
}

// ── Pages ─────────────────────────────────────────────────────────────────────
async function loadPages() {
  try {
    const { pages } = await api.getFlat();
    state.pages = pages;
    renderSidebar();
  } catch (err) {
    showToast('Failed to load pages: ' + err.message, 'error');
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar() {
  const nav = $('sidebar-nav');
  const searchVal = ($('sidebar-search')?.value || '').toLowerCase().trim();

  // Build parent→children map
  const map = {};
  state.pages.forEach(p => { map[p.id] = { ...p, _children: [] }; });
  const roots = [];
  state.pages.forEach(p => {
    if (p.parent_id && map[p.parent_id]) {
      map[p.parent_id]._children.push(map[p.id]);
    } else if (!p.parent_id) {
      roots.push(map[p.id]);
    }
  });

  nav.innerHTML = '';
  const label = document.createElement('div');
  label.className = 'nav-label';
  label.textContent = 'pages';
  nav.appendChild(label);

  if (searchVal) {
    const matched = state.pages.filter(p => {
      const name = (p.display_name || p.name || '').toLowerCase();
      return name.includes(searchVal);
    });
    if (!matched.length) {
      nav.innerHTML += `<div style="text-align:center;padding:20px 0;color:var(--text-dim);font-size:13px;">No results found</div>`;
    } else {
      matched.forEach(p => nav.appendChild(buildNavItem(p, false)));
    }
  } else {
    roots.forEach((p, i) => nav.appendChild(buildNavItem(p, true, i + 1)));
    if (!roots.length) {
      nav.innerHTML += `<div style="text-align:center;padding:24px 0;color:var(--text-dim);font-size:13px;">No pages yet.<br>Click "New Page" to start!</div>`;
    }
  }

  highlightActive();
}

function buildNavItem(page, showNum, num) {
  const isFolder = page.type === 'folder';
  const hasChildren = page._children && page._children.length > 0;
  const isExpanded = state.expandedFolders.has(page.id);
  const displayName = page.display_name || page.name;
  const numStr = page.num || (num ? String(num).padStart(2, '0') : null);

  if (isFolder) {
    const wrapper = document.createElement('div');

    const item = document.createElement('div');
    item.className = 'nav-item';
    item.dataset.pageId = page.id;
    item.innerHTML = `
      <div class="nav-item-inner">
        ${numStr ? `<span class="nav-num">${numStr}</span>` : ''}
        <svg class="nav-icon" viewBox="0 0 20 20" fill="currentColor">
          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
        </svg>
        <span class="nav-name">${esc(displayName)}</span>
        ${page.child_count ? `<span class="nav-count">${page.child_count}</span>` : ''}
      </div>
      ${hasChildren ? `
        <button class="nav-expand-btn${isExpanded ? ' open' : ''}" data-folder-id="${page.id}">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>
        </button>
      ` : ''}
    `;

    item.addEventListener('click', (e) => {
      const isExpandBtn = e.target.closest('.nav-expand-btn');
      if (isExpandBtn) {
        toggleFolder(page.id);
      } else {
        navigateTo(page.id);
      }
    });
    item.addEventListener('contextmenu', e => showCtxMenu(e, page));

    wrapper.appendChild(item);

    if (hasChildren) {
      const childrenEl = document.createElement('div');
      childrenEl.className = `nav-children${isExpanded ? ' open' : ''}`;
      childrenEl.id = `children-${page.id}`;
      page._children.forEach(child => childrenEl.appendChild(buildSubNavItem(child)));
      wrapper.appendChild(childrenEl);
    }

    return wrapper;
  } else {
    const item = document.createElement('div');
    item.className = 'nav-item';
    item.dataset.pageId = page.id;
    const ext = page.file_type || 'md';
    const icon = ext === 'html'
      ? `<svg class="nav-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.083 9h1.946c.089-1.546.383-2.97.837-4.118A6.004 6.004 0 004.083 9zM10 2a8 8 0 100 16A8 8 0 0010 2zm0 2c-.076 0-.232.032-.465.262-.238.234-.497.623-.737 1.182-.389.907-.673 2.142-.766 3.556h3.936c-.093-1.414-.377-2.649-.766-3.556-.24-.56-.5-.948-.737-1.182C10.232 4.032 10.076 4 10 4zm3.971 5c-.089-1.546-.383-2.97-.837-4.118A6.004 6.004 0 0115.917 9h-1.946zm-2.003 2H8.032c.093 1.414.377 2.649.766 3.556.24.56.5.948.737 1.182.233.23.389.262.465.262.076 0 .232-.032.465-.262.238-.234.498-.623.737-1.182.389-.907.673-2.142.766-3.556zm1.166 4.118c.454-1.147.748-2.572.837-4.118h1.946a6.004 6.004 0 01-2.783 4.118zm-6.268 0C6.412 13.97 6.118 12.546 6.03 11H4.083a6.004 6.004 0 002.783 4.118z" clip-rule="evenodd"/></svg>`
      : `<svg class="nav-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"/></svg>`;
    item.innerHTML = `
      <div class="nav-item-inner">
        ${numStr ? `<span class="nav-num">${numStr}</span>` : ''}
        ${icon}
        <span class="nav-name">${esc(displayName)}</span>
        <span class="nav-count">${ext}</span>
      </div>
    `;
    item.addEventListener('click', () => navigateTo(page.id));
    item.addEventListener('contextmenu', e => showCtxMenu(e, page));
    return item;
  }
}

function buildSubNavItem(page) {
  const displayName = page.display_name || page.name;
  const isFolder = page.type === 'folder';
  const item = document.createElement('div');
  item.className = 'nav-sub-item';
  item.dataset.pageId = page.id;
  const icon = isFolder
    ? `<svg class="nav-sub-icon" viewBox="0 0 20 20" fill="currentColor"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>`
    : `<svg class="nav-sub-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"/></svg>`;
  item.innerHTML = `${icon}<span class="nav-sub-name">${esc(displayName)}</span>`;
  item.addEventListener('click', () => navigateTo(page.id));
  item.addEventListener('contextmenu', e => showCtxMenu(e, page));
  return item;
}

function toggleFolder(folderId) {
  const childrenEl = $(`children-${folderId}`);
  const btn = document.querySelector(`[data-folder-id="${folderId}"]`);
  if (state.expandedFolders.has(folderId)) {
    state.expandedFolders.delete(folderId);
    childrenEl?.classList.remove('open');
    btn?.classList.remove('open');
  } else {
    state.expandedFolders.add(folderId);
    childrenEl?.classList.add('open');
    btn?.classList.add('open');
  }
}

function highlightActive() {
  $$('[data-page-id]').forEach(el => {
    const isActive = el.dataset.pageId === state.currentPageId;
    el.classList.toggle('active', isActive);
  });
}

// ── Navigation ────────────────────────────────────────────────────────────────
async function navigateTo(pageId) {
  if (pageId === state.currentPageId) return;

  // Destroy any existing WYSIWYG instance before navigating away
  if (state.wysiwyg) {
    clearTimeout(saveTimer);
    state.wysiwyg = null;
  }

  state.currentPageId = pageId;
  window.location.hash = `page/${pageId}`;

  // Auto-expand parent folder in sidebar
  const page = state.pages.find(p => p.id === pageId);
  if (page?.parent_id) {
    state.expandedFolders.add(page.parent_id);
  }

  await renderPage(pageId);
  renderSidebar();
}

function handleHashRoute() {
  const hash = window.location.hash;
  const match = hash.match(/^#page\/(.+)$/);
  if (match) {
    navigateTo(match[1]);
  } else {
    showWelcome();
  }
}

// ── Page rendering ────────────────────────────────────────────────────────────
async function renderPage(pageId) {
  const content = $('content-area');
  content.className = 'content-area';
  content.innerHTML = `<div class="fade-in" style="text-align:center;padding:60px 0;color:var(--text-dim);"><div>Loading…</div></div>`;
  hideSaveState();

  try {
    const { page } = await api.getPage(pageId);
    state.currentPage = page;
    updateTopbar(page);

    const isPage = page.type === 'page';
    $('compose-btn').classList.toggle('hidden', !isPage);

    if (page.type === 'folder') {
      renderFolderView(page, content);
    } else if (page.file_type === 'md') {
      // md pages are always editable — Notion style
      state.previewMode ? renderMdPreview(page, content) : renderNotionEditor(page, content);
    } else if (page.file_type === 'html') {
      renderHtmlEditor(page, content);
    }
  } catch (err) {
    content.innerHTML = `<div class="fade-in" style="text-align:center;padding:60px 0;color:var(--danger);">Failed to load: ${esc(err.message)}</div>`;
  }
}

function updateTopbar(page) {
  const parent = state.pages.find(p => p.id === page.parent_id);
  $('bc-parent').textContent = parent ? (parent.display_name || parent.name) : 'Notas';
  $('page-title').value = page.display_name || page.name;
  $('topbar-badge').textContent = page.type === 'folder' ? 'folder' : (page.file_type || 'md');
}

// No-op stubs kept for safety (preview toggle removed)
function toggleEditMode() {}
function updatePreviewToggleBtn() {}
function renderMdPreview(page, container) { renderWysiwygEditor(page, container); }
function renderNotionEditor(page, container) { renderWysiwygEditor(page, container); }

// ── WYSIWYG Editor (TipTap — loaded from local bundle) ───────────────────────

// Convert TipTap JSON doc → clean Markdown string
function tiptapToMarkdown(doc) {
  function inline(nodes) {
    if (!nodes) return '';
    return nodes.map(n => {
      let t = n.text || '';
      if (n.marks) {
        n.marks.forEach(m => {
          if (m.type === 'bold') t = `**${t}**`;
          else if (m.type === 'italic') t = `*${t}*`;
          else if (m.type === 'strike') t = `~~${t}~~`;
          else if (m.type === 'code') t = `\`${t}\``;
          else if (m.type === 'link') t = `[${t}](${m.attrs.href || ''})`;
        });
      }
      return t;
    }).join('');
  }

  function block(node, indent) {
    indent = indent || '';
    const t = node.type;
    const c = node.content || [];
    if (t === 'doc') return c.map(n => block(n, '')).join('\n');
    if (t === 'paragraph') return indent + (inline(c) || '') + '\n';
    if (t === 'heading') return '#'.repeat(node.attrs.level) + ' ' + inline(c) + '\n';
    if (t === 'horizontalRule') return '---\n';
    if (t === 'codeBlock') {
      const lang = node.attrs.language || '';
      const code = c.map(n => n.text || '').join('');
      return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }
    if (t === 'blockquote') return c.map(n => '> ' + block(n, '').trimEnd()).join('\n') + '\n';
    if (t === 'bulletList') return c.map(n => block(n, '- ')).join('');
    if (t === 'orderedList') {
      let i = node.attrs.start || 1;
      return c.map(n => block(n, `${i++}. `)).join('');
    }
    if (t === 'taskList') {
      return c.map(n => {
        const checked = n.attrs && n.attrs.checked;
        const checkbox = checked ? '[x]' : '[ ]';
        const content = (n.content || []).map(n2 => block(n2, '')).join('').trimEnd();
        return `- ${checkbox} ${content}\n`;
      }).join('');
    }
    if (t === 'listItem' || t === 'taskItem') {
      const content = c.map(n => block(n, '')).join('').trimEnd();
      return indent + content + '\n';
    }
    if (t === 'hardBreak') return '  \n';
    if (t === 'text') return node.text || '';
    // Fallback: render children
    return c.map(n => block(n, indent)).join('');
  }

  try {
    return block(doc).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  } catch (e) {
    return '';
  }
}

function renderWysiwygEditor(page, container) {
  container.className = 'content-area wysiwyg-wrap fade-in';
  container.innerHTML = `
    <div class="wysiwyg-page">
      <div id="wysiwyg-editor" class="tiptap-host" spellcheck="true"></div>
      <div class="tiptap-hint">
        <span><kbd>**</kbd> bold</span>
        <span><kbd>*</kbd> italic</span>
        <span><kbd># </kbd> heading</span>
        <span><kbd>- </kbd> list</span>
        <span><kbd>[] </kbd> task</span>
        <span><kbd>&gt; </kbd> quote</span>
        <span><kbd>\`\`\` </kbd> code</span>
      </div>
      ${renderAssetsSection(page)}
      ${renderUploadZone(page.id)}
    </div>
  `;
  setupUploadZone(page.id);

  // Destroy previous instance
  if (state.wysiwyg) {
    try { state.wysiwyg.destroy(); } catch {}
    state.wysiwyg = null;
  }

  // Guard: bundle must be loaded
  if (!window.TipTapBundle) {
    showToast('Editor bundle not loaded — please refresh', 'error');
    console.error('TipTapBundle not found on window');
    return;
  }

  const { Editor, Extension, InputRule, StarterKit, TaskList, TaskItem, Placeholder } = window.TipTapBundle;

  // Custom input rule: "[] " → task list (TipTap natively requires "[ ] " with inner space)
  const TaskBracketRule = Extension.create({
    name: 'taskBracketRule',
    addInputRules() {
      return [
        new InputRule({
          find: /^\[\]\s$/,
          handler: ({ chain, range }) => {
            chain().deleteRange(range).toggleTaskList().run();
          },
        }),
      ];
    },
  });

  // Parse initial markdown content as HTML so TipTap can load it
  // Use renderMarkdown() which handles the marked API correctly (sync)
  const initialHtml = page.content ? renderMarkdown(page.content) : '';

  const editor = new Editor({
    element: $('wysiwyg-editor'),
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      TaskBracketRule,
      Placeholder.configure({
        placeholder: 'Start writing… Use # for headings, [] for tasks, - for lists',
      }),
    ],
    content: initialHtml,
    autofocus: true,
    editorProps: {
      attributes: { class: 'tiptap-content', spellcheck: 'true' },
    },
    onUpdate({ editor }) {
      const md = tiptapToMarkdown(editor.getJSON());
      debounceSave(md);
      if (state.currentPage) state.currentPage.content = md;
    },
  });

  state.wysiwyg = editor;

  // Cmd+S → immediate save
  $('wysiwyg-editor').addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') {
      e.preventDefault();
      savePage(tiptapToMarkdown(editor.getJSON()));
    }
  }, true);
}

function renderHtmlEditor(page, container) {
  container.className = 'content-area editor-mode fade-in';
  container.innerHTML = `
    <div class="editor-pane html-editor-wrap" style="flex:1">
      <div class="editor-pane-label">✏️ html source</div>
      <textarea class="editor-textarea" id="editor-textarea" placeholder="Write HTML…" spellcheck="false" style="flex:1">${esc(page.content || '')}</textarea>
    </div>
    <div class="editor-pane html-editor-wrap" style="flex:1;border-right:none">
      <div class="editor-pane-label">👁 live preview</div>
      <iframe class="html-preview-frame" id="html-preview-frame"></iframe>
    </div>
  `;

  const textarea = $('editor-textarea');
  const frame = $('html-preview-frame');
  const updateFrame = () => { frame.srcdoc = textarea.value || '<p>Empty page</p>'; };

  textarea.addEventListener('input', () => { updateFrame(); debounceSave(textarea.value); });
  textarea.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); savePage(textarea.value); }
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = textarea.selectionStart;
      textarea.value = textarea.value.slice(0, s) + '  ' + textarea.value.slice(textarea.selectionEnd);
      textarea.selectionStart = textarea.selectionEnd = s + 2;
      debounceSave(textarea.value);
    }
  });
  updateFrame();
  requestAnimationFrame(() => textarea.focus());
}

// ── Auto-save ─────────────────────────────────────────────────────────────────
let saveTimer;
function debounceSave(content) {
  clearTimeout(saveTimer);
  showSavingState();
  saveTimer = setTimeout(() => savePage(content), 1000);
}

async function savePage(content) {
  if (!state.currentPageId) return;
  clearTimeout(saveTimer);
  showSavingState();
  try {
    await api.updatePage(state.currentPageId, { content });
    if (state.currentPage) state.currentPage.content = content;
    showSavedState();
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
    hideSaveState();
  }
}

function showSavingState() {
  $('saving-indicator')?.classList.remove('hidden');
  $('save-indicator')?.classList.add('hidden');
}
function showSavedState() {
  $('saving-indicator')?.classList.add('hidden');
  const saved = $('save-indicator');
  saved?.classList.remove('hidden');
  setTimeout(() => saved?.classList.add('hidden'), 2500);
}
function hideSaveState() {
  $('saving-indicator')?.classList.add('hidden');
  $('save-indicator')?.classList.add('hidden');
}

// renderMdView kept as alias
function renderMdView(page, container) { renderWysiwygEditor(page, container); }
function renderHtmlView(page, container) { renderHtmlEditor(page, container); }

// ── Folder view ───────────────────────────────────────────────────────────────
function renderFolderView(page, container) {
  container.className = 'content-area fade-in';
  const children = page.children || [];
  const allPages = state.pages;
  const roots = allPages.filter(p => !p.parent_id);
  const rootIdx = roots.findIndex(p => p.id === page.id);
  const sectionNum = rootIdx >= 0 ? String(rootIdx + 1).padStart(2, '0') : (page.num || '—');
  const displayName = page.display_name || page.name;

  container.innerHTML = `
    <div class="folder-index">
      <div class="folder-header">
        <div class="folder-num">SECTION ${sectionNum}</div>
        <h1 class="folder-title">${esc(displayName)}</h1>
        <p class="folder-meta">${children.length} item${children.length !== 1 ? 's' : ''}</p>
      </div>

      <div class="section-heading">Contents</div>
      ${children.length ? `
        <div class="children-grid">
          ${children.map(child => {
            const childName = child.display_name || child.name;
            const ext = child.file_type || '';
            return `
              <div class="child-card" onclick="navigateTo('${child.id}')">
                <div class="child-card-icon ${child.type === 'folder' ? 'folder' : ext}">
                  ${child.type === 'folder' ? '📁' : ext === 'html' ? '🌐' : '📝'}
                </div>
                <div class="child-card-name">${esc(childName)}</div>
                <div class="child-card-meta">${child.type === 'folder' ? `${child.child_count || 0} items` : ext.toUpperCase() || 'MD'}</div>
              </div>
            `;
          }).join('')}
        </div>
      ` : `<div style="color:var(--text-dim);font-size:14px;padding:20px 0;">This folder is empty. Add pages using the "New Page" button.</div>`}

      ${renderAssetsSection(page)}
      ${renderUploadZone(page.id)}
    </div>
  `;
  setupUploadZone(page.id);
}

// ── Assets ────────────────────────────────────────────────────────────────────
function renderAssetsSection(page) {
  const assets = page.assets || [];
  if (!assets.length) return '';

  const imgs = assets.filter(a => a.mime_type?.startsWith('image/'));
  const files = assets.filter(a => !a.mime_type?.startsWith('image/'));

  return `
    <div class="assets-section">
      ${imgs.length ? `
        <div class="section-heading">Images & Media · ${imgs.length}</div>
        <div class="asset-grid">
          ${imgs.map(a => `
            <div class="asset-card">
              <div class="asset-preview">
                <img src="${api.assetUrl(a.id)}" alt="${esc(a.original_name)}" loading="lazy">
                <div class="asset-overlay">
                  <button class="asset-overlay-btn" onclick="openLightbox('${api.assetUrl(a.id)}','${esc(a.original_name)}')" title="View">👁</button>
                  <button class="asset-overlay-btn" onclick="copyToClipboard('${api.assetUrl(a.id)}')" title="Copy URL">📋</button>
                  <button class="asset-overlay-btn" onclick="deleteAsset('${a.id}')" title="Delete" style="color:var(--danger)">🗑</button>
                </div>
              </div>
              <div class="asset-info">
                <div class="asset-name">${esc(a.original_name)}</div>
                <div class="asset-type">${(a.size/1024).toFixed(1)} KB</div>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
      ${files.length ? `
        <div class="section-heading" style="margin-top:${imgs.length?'24px':0}">Files · ${files.length}</div>
        ${files.map(a => {
          const ext = a.original_name.split('.').pop().toUpperCase();
          return `
            <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;display:flex;align-items:center;gap:12px;margin-bottom:7px;">
              <div style="font-size:24px;flex-shrink:0">📄</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.original_name)}</div>
                <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim)">${ext} · ${(a.size/1024).toFixed(1)} KB</div>
              </div>
              <div style="display:flex;gap:6px">
                <a href="${api.assetUrl(a.id)}" download="${esc(a.original_name)}" class="btn btn-ghost btn-sm">↓ Download</a>
                <button class="btn btn-danger btn-sm" onclick="deleteAsset('${a.id}')">Delete</button>
              </div>
            </div>
          `;
        }).join('')}
      ` : ''}
    </div>
  `;
}

function renderUploadZone(pageId) {
  return `
    <div class="assets-section">
      <div class="section-heading">Upload Files</div>
      <div class="upload-zone" id="upload-zone-${pageId}" onclick="triggerUpload('${pageId}')">
        <div class="upload-zone-icon">📎</div>
        <div class="upload-zone-text">Drop files here or click to upload</div>
        <div class="upload-zone-hint">Images, PDFs, videos — up to 50 MB</div>
      </div>
      <input type="file" id="upload-input-${pageId}" multiple style="display:none" onchange="handleFileUpload(event,'${pageId}')">
    </div>
  `;
}

function setupUploadZone(pageId) {
  const zone = $(`upload-zone-${pageId}`);
  if (!zone) return;
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    uploadFiles(e.dataTransfer.files, pageId);
  });
}

function triggerUpload(pageId) {
  $(`upload-input-${pageId}`)?.click();
}

function handleFileUpload(e, pageId) {
  uploadFiles(e.target.files, pageId);
}

async function uploadFiles(files, pageId) {
  if (!files.length) return;
  showToast(`Uploading ${files.length} file(s)…`);
  const form = new FormData();
  for (const f of files) form.append('files', f);
  form.append('page_id', pageId);
  try {
    await api.uploadFiles(form);
    showToast('Uploaded!');
    await renderPage(pageId);
  } catch (err) {
    showToast('Upload failed: ' + err.message, 'error');
  }
}

async function deleteAsset(assetId) {
  if (!confirm('Delete this asset?')) return;
  try {
    await api.deleteAsset(assetId);
    showToast('Deleted');
    if (state.currentPageId) await renderPage(state.currentPageId);
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

// ── Create page/folder modal ──────────────────────────────────────────────────
function openNewPageModal(defaultType) {
  defaultType = defaultType || 'page';
  $('new-page-overlay').classList.add('open');
  $('new-page-type').value = defaultType;
  updateTypeOptions(defaultType);
  $('new-page-name').value = '';
  $('new-page-ai-prompt').value = '';
  $('new-page-ai-section').style.display = 'none';
  $('new-page-name').focus();
}

function closeNewPageModal() {
  $('new-page-overlay').classList.remove('open');
}

function updateTypeOptions(type) {
  $$('.type-option').forEach(opt => opt.classList.toggle('selected', opt.dataset.type === type));
  $('new-page-file-type-row').style.display = type === 'folder' ? 'none' : '';
}

function selectType(type) {
  $('new-page-type').value = type;
  updateTypeOptions(type);
}

function toggleAiFill() {
  const section = $('new-page-ai-section');
  const isHidden = section.style.display === 'none' || !section.style.display;
  section.style.display = isHidden ? '' : 'none';
  if (isHidden) $('new-page-ai-prompt').focus();
}

async function submitNewPage() {
  const name = $('new-page-name').value.trim();
  const type = $('new-page-type').value;
  const fileType = $('new-page-file-type').value;
  const aiPrompt = $('new-page-ai-prompt').value.trim();
  const parentId = state.currentPage?.type === 'folder' ? state.currentPage.id : (state.currentPage?.parent_id || null);

  if (!name) { showToast('Please enter a name', 'error'); return; }

  const btn = $('new-page-submit');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    let content = '';

    if (type === 'page' && aiPrompt) {
      showToast('Generating content with AI… ⏳');
      const { content: gen } = await api.generate({ prompt: aiPrompt, type: fileType });
      content = gen;
    }

    const { page } = await api.createPage({ name, type, file_type: type === 'folder' ? null : fileType, parent_id: parentId, content });
    closeNewPageModal();
    await loadPages();
    if (type !== 'folder') await navigateTo(page.id);
    showToast(`${type === 'folder' ? 'Folder' : 'Page'} created!`);
  } catch (err) {
    showToast('Failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
}

// ── Welcome screen ────────────────────────────────────────────────────────────
function showWelcome() {
  state.currentPageId = null;
  state.currentPage = null;
  state.editMode = false;
  const content = $('content-area');
  content.className = 'content-area';
  content.innerHTML = `
    <div class="welcome-state fade-in">
      <div class="welcome-icon">📓</div>
      <h1 class="welcome-title">Welcome to Notas</h1>
      <p class="welcome-sub">
        Create folders and pages to organize your knowledge.<br>
        All pages are stored as <strong>.md</strong> and <strong>.html</strong> files in <code style="font-family:'IBM Plex Mono',monospace;font-size:13px;background:var(--surface-2);padding:2px 6px;border-radius:4px;">data/pages/</code>
      </p>
      <div style="display:flex;gap:10px;margin-top:8px;">
        <button class="btn btn-primary" onclick="openNewPageModal('folder')">📁 New Folder</button>
        <button class="btn btn-ghost" onclick="openNewPageModal('page')">📝 New Page</button>
      </div>
    </div>
  `;
  $('topbar-badge').textContent = '';
  $('page-title').value = '';
  $('bc-parent').textContent = 'Notas';
  $('compose-btn').classList.add('hidden');
  $('edit-toggle-btn').classList.add('hidden');
  hideSaveState();
}

// ── Context menu ──────────────────────────────────────────────────────────────
const ctxMenu = document.createElement('div');
ctxMenu.className = 'ctx-menu';
ctxMenu.id = 'ctx-menu';
document.body.appendChild(ctxMenu);

function showCtxMenu(e, page) {
  e.preventDefault();
  const displayName = page.display_name || page.name;
  ctxMenu.innerHTML = `
    <div class="ctx-menu-item" onclick="renamePagePrompt('${page.id}','${esc(displayName)}')">✏️ Rename</div>
    ${page.type === 'folder' ? `<div class="ctx-menu-item" onclick="openNewPageModal('page')">📄 Add Page Inside</div>` : ''}
    <div class="ctx-menu-sep"></div>
    <div class="ctx-menu-item danger" onclick="deletePageConfirm('${page.id}','${esc(displayName)}')">🗑 Delete</div>
  `;
  ctxMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 180)}px`;
  ctxMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 120)}px`;
  ctxMenu.classList.add('open');
}

document.addEventListener('click', () => ctxMenu.classList.remove('open'));

async function renamePagePrompt(id, currentDisplayName) {
  const newName = prompt('Rename:', currentDisplayName);
  if (!newName || newName === currentDisplayName) return;
  try {
    await api.updatePage(id, { name: newName });
    await loadPages();
    if (state.currentPageId === id && state.currentPage) {
      state.currentPage.display_name = newName;
      $('page-title').value = newName;
    }
    showToast('Renamed!');
  } catch (err) {
    showToast('Rename failed: ' + err.message, 'error');
  }
}

async function deletePageConfirm(id, name) {
  if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;
  try {
    await api.deletePage(id);
    await loadPages();
    if (state.currentPageId === id) showWelcome();
    showToast('Deleted!');
  } catch (err) {
    showToast('Delete failed: ' + err.message, 'error');
  }
}

// ── Page title inline editing ─────────────────────────────────────────────────
let titleTimer;
function onTitleChange(e) {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(async () => {
    if (!state.currentPageId) return;
    const val = e.target.value.trim();
    if (!val) return;
    try {
      const res = await api.updatePage(state.currentPageId, { name: val });
      // ID may change after rename (path changes)
      if (res.page?.id && res.page.id !== state.currentPageId) {
        state.currentPageId = res.page.id;
        window.location.hash = `page/${res.page.id}`;
      }
      await loadPages();
    } catch {}
  }, 900);
}

// ── Compose (+ button AI section) ─────────────────────────────────────────────
function openCompose() {
  $('compose-popup').classList.toggle('open');
  $('compose-input').focus();
}

async function submitCompose() {
  const prompt = $('compose-input').value.trim();
  if (!prompt || !state.currentPage) return;

  const btn = $('compose-submit');
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const { content: newSection } = await api.generate({
      prompt,
      type: state.currentPage.file_type || 'md',
      context: (state.currentPage.content || '').slice(0, 1500)
    });
    const sep = state.currentPage.file_type === 'html' ? '\n\n<!-- section -->\n' : '\n\n---\n\n';
    const newContent = (state.currentPage.content || '') + sep + newSection;
    await api.updatePage(state.currentPageId, { content: newContent });
    state.currentPage.content = newContent;
    $('compose-popup').classList.remove('open');
    $('compose-input').value = '';
    await renderPage(state.currentPageId);
    showToast('Section added!');
  } catch (err) {
    showToast('AI failed: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Generate';
  }
}

// ── Chat drawer ───────────────────────────────────────────────────────────────
function toggleChat() {
  state.chatOpen = !state.chatOpen;
  $('chat-drawer').classList.toggle('open', state.chatOpen);
  if (state.chatOpen && state.currentPageId) loadChatHistory();
}

async function loadChatHistory() {
  if (!state.currentPageId) return;
  try {
    const { messages } = await api.getChatHistory(state.currentPageId);
    state.chatMessages = messages.map(m => ({ role: m.role, content: m.content }));
    renderChatMessages();
  } catch {}
}

function renderChatMessages() {
  const container = $('chat-messages');
  if (!state.chatMessages.length) {
    container.innerHTML = `<div style="text-align:center;padding:32px 0;color:var(--text-dim);font-size:13px;"><div style="font-size:32px;margin-bottom:8px">🤖</div>Ask me anything about this page, or request edits!</div>`;
    return;
  }
  container.innerHTML = state.chatMessages.map(m => `
    <div class="chat-msg ${m.role}">
      <div class="chat-msg-role">${m.role === 'user' ? 'You' : 'AI'}</div>
      <div class="chat-msg-content">${m.role === 'assistant' ? renderMarkdownSimple(m.content) : esc(m.content)}</div>
    </div>
  `).join('');
  container.scrollTop = container.scrollHeight;
}

function renderMarkdownSimple(text) {
  return text
    .replace(/```[\s\S]*?```/g, m => `<pre style="background:var(--surface-3);padding:8px;border-radius:6px;font-size:12px;overflow-x:auto;margin:6px 0"><code>${esc(m.slice(3,-3).replace(/^[^\n]*\n/, ''))}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

async function sendChatMessage() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text || state.chatStreaming) return;

  input.value = '';
  input.style.height = 'auto';
  state.chatMessages.push({ role: 'user', content: text });
  renderChatMessages();

  const typingId = 'typing-' + Date.now();
  $('chat-messages').innerHTML += `
    <div class="chat-msg assistant" id="${typingId}">
      <div class="chat-msg-role">AI</div>
      <div class="chat-typing"><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div></div>
    </div>
  `;
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;

  state.chatStreaming = true;
  $('chat-send-btn').disabled = true;

  let reply = '';
  const pageContent = state.currentPage?.content || '';

  await api.chatStream(
    state.chatMessages.filter(m => m.role !== 'system'),
    state.currentPageId,
    pageContent,
    chunk => {
      reply += chunk;
      const el = $(typingId);
      if (el) {
        const inner = el.querySelector('.chat-msg-content, .chat-typing');
        if (inner) inner.outerHTML = `<div class="chat-msg-content">${renderMarkdownSimple(reply)}</div>`;
      }
      $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
    },
    () => {
      state.chatMessages.push({ role: 'assistant', content: reply });
      state.chatStreaming = false;
      $('chat-send-btn').disabled = false;
      renderChatMessages();
    },
    err => {
      state.chatStreaming = false;
      $('chat-send-btn').disabled = false;
      showToast('Chat error: ' + err, 'error');
      $(typingId)?.remove();
    }
  );
}

function clearChat() {
  state.chatMessages = [];
  renderChatMessages();
}

async function applyAiSuggestion() {
  if (!state.chatMessages.length || !state.currentPageId) return;
  const last = [...state.chatMessages].reverse().find(m => m.role === 'assistant');
  if (!last) return;
  const newContent = (state.currentPage?.content || '') + '\n\n---\n\n' + last.content;
  try {
    await api.updatePage(state.currentPageId, { content: newContent });
    if (state.currentPage) state.currentPage.content = newContent;
    if (!state.editMode) await renderPage(state.currentPageId);
    showToast('Content applied!');
  } catch {}
}

// ── Settings modal ────────────────────────────────────────────────────────────
async function openSettings() {
  $('settings-overlay').classList.add('open');
  try {
    const { settings } = await api.getSettings();
    state.settings = settings;
    $('settings-provider').value = settings.llm_provider || 'openai';
    $('settings-model').value = settings.llm_model || '';
    $('settings-api-key').value = '';
    $('settings-api-key').placeholder = settings.llm_api_key_masked || 'Enter API key…';
    $('settings-base-url').value = settings.llm_base_url || '';
    $('settings-image-model').value = settings.image_model || 'dall-e-3';
    updateProviderCards(settings.llm_provider || 'openai');
    updateProviderUI(settings.llm_provider || 'openai');
  } catch (err) {
    showToast('Failed to load settings', 'error');
  }
}

function closeSettings() {
  $('settings-overlay').classList.remove('open');
}

function selectProvider(p) {
  $('settings-provider').value = p;
  updateProviderCards(p);
  updateProviderUI(p);
  const defaults = { openai: 'gpt-4o-mini', gemini: 'gemini-2.0-flash', claude: 'claude-3-5-haiku-20241022', 'openai-compatible': '' };
  if (!$('settings-model').value) $('settings-model').value = defaults[p] || '';
}

function updateProviderCards(p) {
  $$('.provider-card').forEach(c => c.classList.toggle('selected', c.dataset.provider === p));
}

function updateProviderUI(p) {
  $('base-url-row').style.display = p === 'openai-compatible' ? '' : 'none';
}

async function saveSettings() {
  const updates = {
    llm_provider: $('settings-provider').value,
    llm_model: $('settings-model').value,
    llm_base_url: $('settings-base-url').value,
    image_model: $('settings-image-model').value,
  };
  const key = $('settings-api-key').value;
  if (key) updates.llm_api_key = key;
  try {
    await api.saveSettings(updates);
    closeSettings();
    showToast('Settings saved!');
  } catch (err) {
    showToast('Save failed: ' + err.message, 'error');
  }
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(src, name) {
  $('lightbox-img').src = src;
  $('lightbox-name').textContent = name || '';
  $('lightbox').classList.add('open');
}
function closeLightbox() {
  $('lightbox').classList.remove('open');
}

// ── Clipboard ─────────────────────────────────────────────────────────────────
async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(window.location.origin + text);
    showToast('URL copied!');
  } catch {
    showToast('Copy failed', 'error');
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer;
function showToast(msg, type) {
  type = type || 'info';
  const toast = $('toast');
  toast.querySelector('.toast-text').textContent = msg;
  toast.className = `toast ${type === 'error' ? 'error' : ''} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ── Search ────────────────────────────────────────────────────────────────────
let searchTimer;
function onSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderSidebar(), 200);
}

// ── Markdown render helper ────────────────────────────────────────────────────
function renderMarkdown(text) {
  if (typeof marked !== 'undefined') {
    // marked v9+ returns a Promise by default — force sync mode
    const result = marked.parse(text || '', { async: false });
    if (typeof result === 'string') return result;
    // If it's a Promise somehow, fall through to pre
  }
  return `<pre>${esc(text || '')}</pre>`;
}

// ── HTML escape ───────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Event listeners ───────────────────────────────────────────────────────────
function setupEventListeners() {
  $('theme-btn').addEventListener('click', toggleTheme);
  $('sidebar-search').addEventListener('input', onSearch);
  $('btn-new-page').addEventListener('click', () => openNewPageModal('page'));
  $('btn-new-folder').addEventListener('click', () => openNewPageModal('folder'));
  $('settings-btn').addEventListener('click', openSettings);
  $('chat-toggle').addEventListener('click', toggleChat);
  $('chat-close-btn').addEventListener('click', toggleChat);

  $('chat-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  $('chat-input').addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  $('compose-btn').addEventListener('click', openCompose);
  $('compose-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitCompose();
    if (e.key === 'Escape') $('compose-popup').classList.remove('open');
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.compose-popup') && !e.target.closest('#compose-btn')) {
      $('compose-popup').classList.remove('open');
    }
  });

  $('new-page-overlay').addEventListener('click', e => { if (e.target === $('new-page-overlay')) closeNewPageModal(); });
  $('settings-overlay').addEventListener('click', e => { if (e.target === $('settings-overlay')) closeSettings(); });
  $('lightbox').addEventListener('click', e => { if (e.target === $('lightbox')) closeLightbox(); });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeLightbox();
      $('compose-popup').classList.remove('open');
    }
  });

  $('page-title').addEventListener('input', onTitleChange);
  $('new-page-type').addEventListener('change', e => updateTypeOptions(e.target.value));

  // Cmd+P → toggle preview (also handled inside textarea keydown, but this covers global context)
  document.addEventListener('keydown', e => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'p' && !e.target.closest('.notion-textarea, #editor-textarea, #chat-input, .form-input, .form-textarea')) {
      e.preventDefault();
      if (state.currentPage && state.currentPage.file_type === 'md') toggleEditMode();
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
