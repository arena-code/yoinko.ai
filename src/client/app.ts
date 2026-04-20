// src/client/app.ts — Main application logic (filesystem-backed)
import { api, getCurrentProjectId, setCurrentProjectId } from './api.js';
import type { PageNode, Asset, Settings, LLMMessage, Project } from '../shared/types.js';

// ── TipTap bundle type declaration ────────────────────────────────────────────
interface TipTapBundle {
  Editor: new (opts: Record<string, unknown>) => {
    getJSON: () => TipTapDoc;
    destroy: () => void;
  };
  Extension: { create: (opts: Record<string, unknown>) => unknown };
  InputRule: new (opts: Record<string, unknown>) => unknown;
  StarterKit: unknown;
  TaskList: unknown;
  TaskItem: { configure: (opts: Record<string, unknown>) => unknown };
  Placeholder: { configure: (opts: Record<string, unknown>) => unknown };
}

interface TipTapDoc {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapDoc[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

declare global {
  interface Window {
    TipTapBundle: TipTapBundle;
    // Globals used inline in HTML (onclick=)
    navigateTo: (id: string) => void;
    openNewPageModal: (type: 'page' | 'folder' | 'image', ctxFolderId?: string) => void;
    openLightbox: (src: string, name: string) => void;
    copyToClipboard: (text: string) => void;
    deleteAsset: (id: string) => void;
    renamePagePrompt: (id: string, name: string) => void;
    deletePageConfirm: (id: string, name: string) => void;
    submitRename: () => void;
    submitDelete: () => void;
    selectType: (type: 'page' | 'folder') => void;
    toggleAiFill: () => void;
    submitNewPage: () => void;
    closeNewPageModal: () => void;
    openSettings: () => void;
    closeSettings: () => void;
    selectProvider: (p: string) => void;
    saveSettings: () => void;
    toggleCustomImageModel: (val: string) => void;
    toggleHtmlEditMode: () => void;
    submitCompose: () => void;
    triggerUpload: (pageId: string) => void;
    handleFileUpload: (e: Event, pageId: string) => void;
    clearChat: () => void;
    applyAiSuggestion: () => void;
    closeLightbox: () => void;
    sendChatMessage: () => void;
    toggleChat: () => void;
    switchProject: (id: string) => void;
    openCreateProjectModal: () => void;
    closeCreateProjectModal: () => void;
    submitCreateProject: () => void;
    deleteProjectConfirm: (id: string, name: string) => void;
    closeConfirmDeleteProject: (result: boolean) => void;
    toggleProjectMenu: () => void;
  }

  // Marked declared as global from CDN script tag
  const marked: { parse: (text: string, opts?: { async?: boolean }) => string | Promise<string> };
}

// ── State ─────────────────────────────────────────────────────────────────────
interface NavPageNode extends PageNode {
  _children: NavPageNode[];
}

interface AppState {
  pages: PageNode[];
  projects: Project[];
  currentPageId: string | null;
  currentPage: PageNode | null;
  theme: string;
  chatOpen: boolean;
  chatMessages: LLMMessage[];
  chatStreaming: boolean;
  expandedFolders: Set<string>;
  settings: Partial<Settings>;
  wysiwyg: { getJSON: () => TipTapDoc; destroy: () => void } | null;
  previewMode?: boolean;
  editMode?: boolean;
}

const state: AppState = {
  pages: [],
  projects: [],
  currentPageId: null,
  currentPage: null,
  theme: 'dark',
  chatOpen: false,
  chatMessages: [],
  chatStreaming: false,
  expandedFolders: new Set(),
  settings: {},
  wysiwyg: null,
};

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const $$ = (sel: string): NodeListOf<HTMLElement> => document.querySelectorAll(sel);

// ── Init ──────────────────────────────────────────────────────────────────────
async function init(): Promise<void> {
  // Register all inline-onclick globals FIRST so they're available regardless of
  // whether loadPages / setupEventListeners throws later.
  window.navigateTo = navigateTo;
  window.openNewPageModal = openNewPageModal;
  window.openLightbox = openLightbox;
  window.copyToClipboard = copyToClipboard;
  window.deleteAsset = deleteAsset;
  window.renamePagePrompt = renamePagePrompt;
  window.deletePageConfirm = deletePageConfirm;
  window.submitRename = submitRename;
  window.submitDelete = submitDelete;
  window.selectType = selectType;
  window.toggleAiFill = toggleAiFill;
  window.submitNewPage = submitNewPage;
  window.closeNewPageModal = closeNewPageModal;
  window.openSettings = openSettings;
  window.closeSettings = closeSettings;
  window.selectProvider = selectProvider;
  window.saveSettings = saveSettings;
  window.toggleCustomImageModel = toggleCustomImageModel;
  window.toggleHtmlEditMode = toggleHtmlEditMode;
  window.submitCompose = submitCompose;
  window.triggerUpload = triggerUpload;
  window.handleFileUpload = handleFileUpload;
  window.clearChat = clearChat;
  window.applyAiSuggestion = applyAiSuggestion;
  window.closeLightbox = closeLightbox;
  window.sendChatMessage = sendChatMessage;
  window.toggleChat = toggleChat;
  window.switchProject = switchProject;
  window.openCreateProjectModal = openCreateProjectModal;
  window.closeCreateProjectModal = closeCreateProjectModal;
  window.submitCreateProject = submitCreateProject;
  window.deleteProjectConfirm = deleteProjectConfirm;
  window.closeConfirmDeleteProject = closeConfirmDeleteProject;
  window.openRenameProjectModal = openRenameProjectModal;
  window.closeRenameProjectModal = closeRenameProjectModal;
  window.submitRenameProject = submitRenameProject;
  window.toggleProjectMenu = () => {
    const menu = document.getElementById('project-menu');
    if (menu) menu.classList.toggle('open');
  };

  await loadSettings();
  applyTheme(state.theme);
  await loadProjects();  // must happen before loadPages
  await loadPages();
  setupEventListeners();
  handleHashRoute();
  window.addEventListener('hashchange', handleHashRoute);
}

// ── Projects ──────────────────────────────────────────────────────────────────
async function loadProjects(): Promise<void> {
  try {
    const { projects } = await api.listProjects();
    state.projects = projects;

    // Validate stored project still exists
    const stored = getCurrentProjectId();
    if (!projects.find(p => p.id === stored)) {
      setCurrentProjectId('default');
    }

    renderProjectSwitcher();
  } catch { /* silently fail — server may not have migrated yet */ }
}

function renderProjectSwitcher(): void {
  const switcher = document.getElementById('project-switcher');
  if (!switcher) return;

  const currentId = getCurrentProjectId();
  const current = state.projects.find(p => p.id === currentId) ?? state.projects[0];
  const currentName = current?.name ?? 'Default';
  const initials = (name: string) => name.slice(0, 2).toUpperCase();

  const hue = (name: string) => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
    return h;
  };

  const avatarStyle = (name: string, isDefault: boolean) =>
    isDefault ? '' : `style="background: hsl(${hue(name)}, 60%, 48%)"`;

  switcher.innerHTML = `
    <button class="project-switcher-btn" onclick="toggleProjectMenu()" title="Switch project">
      <span class="project-switcher-avatar" ${avatarStyle(currentName, currentId === 'default')}>${initials(currentName)}</span>
      <span class="project-switcher-name">${currentName}</span>
      <svg class="project-switcher-arrow" viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
    </button>
    <div class="project-menu" id="project-menu">
      <div class="project-menu-label">Workspaces</div>
      ${state.projects.map(p => {
        const isActive = p.id === currentId;
        // Use <div role="button"> so we can nest real <button> inside for delete
        return `
        <div class="project-menu-item${isActive ? ' project-menu-item--active' : ''}"
             role="button" tabindex="0"
             onclick="switchProject('${p.id}')"
             onkeydown="if(event.key==='Enter'||event.key===' ')switchProject('${p.id}')">
          <span class="project-menu-avatar" ${avatarStyle(p.name, p.id === 'default')}>${initials(p.name)}</span>
          <span class="project-menu-item-name">${p.name}</span>
          ${p.id !== 'default'
            ? `<span class="project-menu-actions">
                 <button class="project-menu-action-btn"
                         onclick="event.stopPropagation();openRenameProjectModal('${p.id}','${p.name}')"
                         title="Rename workspace">
                   <svg viewBox="0 0 12 12" fill="none" width="11" height="11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                     <path d="M8.5 1.5a1.414 1.414 0 012 2L3.5 10.5l-3 .5.5-3z"/>
                   </svg>
                 </button>
                 <button class="project-menu-action-btn project-menu-action-delete"
                         onclick="event.stopPropagation();deleteProjectConfirm('${p.id}','${p.name}')"
                         title="Delete workspace">
                   <svg viewBox="0 0 10 10" fill="none" width="9" height="9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                     <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
                   </svg>
                 </button>
               </span>`
            : '<span class="project-menu-spacer"></span>'
          }
        </div>`;
      }).join('')}
      <div class="project-menu-divider"></div>
      <div class="project-menu-item project-menu-new"
           role="button" tabindex="0"
           onclick="openCreateProjectModal()"
           onkeydown="if(event.key==='Enter')openCreateProjectModal()">
        <span class="project-menu-new-icon">+</span>
        <span>New workspace</span>
      </div>
    </div>
  `;
}

// Close project menu when clicking outside
document.addEventListener('click', (e: MouseEvent) => {
  const menu = document.getElementById('project-menu');
  const switcher = document.getElementById('project-switcher');
  if (menu?.classList.contains('open') && !switcher?.contains(e.target as Node)) {
    menu.classList.remove('open');
  }
});

async function switchProject(id: string): Promise<void> {
  if (id === getCurrentProjectId()) return;
  setCurrentProjectId(id);

  // Close menu
  document.getElementById('project-menu')?.classList.remove('open');

  // Clear current page
  state.currentPageId = null;
  state.currentPage = null;
  state.chatMessages = [];

  // Reload UI
  renderProjectSwitcher();
  await loadPages();
  $('main-content').innerHTML = '<div class="empty-state"><p>Select a page to get started.</p></div>';
  showToast(`Switched to ${state.projects.find(p => p.id === id)?.name ?? id}`);
}

// Create project modal
function openCreateProjectModal(): void {
  document.getElementById('project-menu')?.classList.remove('open');
  const overlay = document.getElementById('create-project-overlay');
  if (overlay) overlay.classList.add('open');
  const input = document.getElementById('new-project-name') as HTMLInputElement;
  if (input) { input.value = ''; input.focus(); }
}

function closeCreateProjectModal(): void {
  document.getElementById('create-project-overlay')?.classList.remove('open');
}

async function submitCreateProject(): Promise<void> {
  const input = document.getElementById('new-project-name') as HTMLInputElement;
  const name = input?.value?.trim();
  if (!name) return;

  try {
    const { project } = await api.createProject(name);
    state.projects.push(project);
    closeCreateProjectModal();
    await switchProject(project.id);
  } catch (err) {
    showToast('Failed to create project: ' + (err as Error).message, 'error');
  }
}

// Delete project confirmation (reuses the existing confirm-delete modal)
let _deleteProjectId: string | null = null;

async function deleteProjectConfirm(id: string, name: string): Promise<void> {
  _deleteProjectId = id;
  const confirmed = await showConfirmDelete(name, 'Delete workspace?');
  if (!confirmed) { _deleteProjectId = null; return; }

  try {
    await api.deleteProject(id);
    state.projects = state.projects.filter(p => p.id !== id);
    if (getCurrentProjectId() === id) {
      await switchProject('default');
    } else {
      renderProjectSwitcher();
    }
    showToast(`"${name}" deleted`);
  } catch (err) {
    showToast((err as Error).message, 'error');
  }
  _deleteProjectId = null;
}

// Needed for window assignment — close project confirm just delegates to closeConfirmDelete
function closeConfirmDeleteProject(result: boolean): void {
  closeConfirmDelete(result);
}


// ── Rename project ────────────────────────────────────────────────────────────
let _renameProjectId: string | null = null;

function openRenameProjectModal(id: string, currentName: string): void {
  _renameProjectId = id;
  document.getElementById('project-menu')?.classList.remove('open');
  const overlay = document.getElementById('rename-project-overlay');
  if (overlay) overlay.classList.add('open');
  const input = document.getElementById('rename-project-input') as HTMLInputElement;
  if (input) { input.value = currentName; input.focus(); input.select(); }
}

function closeRenameProjectModal(): void {
  document.getElementById('rename-project-overlay')?.classList.remove('open');
  _renameProjectId = null;
}

async function submitRenameProject(): Promise<void> {
  const input = document.getElementById('rename-project-input') as HTMLInputElement;
  const name = input?.value.trim();
  if (!name || !_renameProjectId) return;
  try {
    const { project } = await api.renameProject(_renameProjectId, name);
    const idx = state.projects.findIndex(p => p.id === project.id);
    if (idx !== -1) state.projects[idx] = project;
    renderProjectSwitcher();
    closeRenameProjectModal();
    showToast(`Renamed to "${name}"`);
  } catch (err) {
    showToast((err as Error).message, 'error');
  }
}

// ── Settings ──────────────────────────────────────────────────────────────────
async function loadSettings(): Promise<void> {
  try {
    const { settings } = await api.getSettings();
    state.settings = settings;
    state.theme = settings.theme || 'dark';
  } catch { /* silently fail */ }
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(theme: string): void {
  state.theme = theme;
  document.documentElement.setAttribute('data-theme', theme);
  const themeIcon = $('theme-icon') as HTMLElement | null;
  if (themeIcon) themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
}

function toggleTheme(): void {
  const next = state.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  api.saveSettings({ theme: next as Settings['theme'] });
}

// ── Pages ─────────────────────────────────────────────────────────────────────
async function loadPages(): Promise<void> {
  try {
    const { pages } = await api.getFlat();
    state.pages = pages;
    renderSidebar();
  } catch (err) {
    showToast('Failed to load pages: ' + (err as Error).message, 'error');
  }
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function renderSidebar(): void {
  const nav = $('sidebar-nav');
  const searchEl = $('sidebar-search') as HTMLInputElement | null;
  const searchVal = (searchEl?.value || '').toLowerCase().trim();

  const map: Record<string, NavPageNode> = {};
  state.pages.forEach(p => { map[p.id] = { ...p, _children: [] }; });
  const roots: NavPageNode[] = [];
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
      matched.forEach(p => nav.appendChild(buildNavItem(map[p.id], false)));
    }
  } else {
    roots.forEach((p, i) => nav.appendChild(buildNavItem(p, true, i + 1)));
    if (!roots.length) {
      nav.innerHTML += `<div style="text-align:center;padding:24px 0;color:var(--text-dim);font-size:13px;">No pages yet.<br>Click "New Page" to start!</div>`;
    }
  }

  highlightActive();
}

function buildNavItem(page: NavPageNode, showNum: boolean, num?: number): HTMLElement {
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

      </div>
      ${hasChildren ? `
        <button class="nav-expand-btn${isExpanded ? ' open' : ''}" data-folder-id="${page.id}">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>
        </button>
      ` : ''}
    `;
    item.addEventListener('click', (e) => {
      const isExpandBtn = (e.target as Element).closest('.nav-expand-btn');
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

function buildSubNavItem(page: NavPageNode): HTMLElement {
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

function toggleFolder(folderId: string): void {
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

function highlightActive(): void {
  $$('[data-page-id]').forEach(el => {
    const isActive = el.dataset.pageId === state.currentPageId;
    el.classList.toggle('active', isActive);
  });
}

// ── Navigation ────────────────────────────────────────────────────────────────
async function navigateTo(pageId: string): Promise<void> {
  if (pageId === state.currentPageId) return;

  if (state.wysiwyg) {
    clearTimeout(saveTimer as ReturnType<typeof setTimeout>);
    state.wysiwyg = null;
  }

  state.currentPageId = pageId;
  window.location.hash = `page/${pageId}`;

  const page = state.pages.find(p => p.id === pageId);
  if (page?.parent_id) {
    state.expandedFolders.add(page.parent_id);
  }
  // Auto-expand folders when selected
  if (page?.type === 'folder') {
    state.expandedFolders.add(pageId);
  }

  await renderPage(pageId);
  renderSidebar();
}

function handleHashRoute(): void {
  const hash = window.location.hash;
  const match = hash.match(/^#page\/(.+)$/);
  if (match) {
    navigateTo(match[1]);
  } else {
    showWelcome();
  }
}

// ── Page rendering ────────────────────────────────────────────────────────────
async function renderPage(pageId: string): Promise<void> {
  const content = $('content-area');
  content.className = 'content-area';
  content.innerHTML = `<div class="fade-in" style="text-align:center;padding:60px 0;color:var(--text-dim);"><div>Loading…</div></div>`;
  hideSaveState();

  try {
    const { page } = await api.getPage(pageId);
    state.currentPage = page;
    updateTopbar(page);

    const isPage = page.type === 'page';
    const isMd = page.file_type === 'md';
    const isHtml = isPage && page.file_type === 'html';
    $('compose-btn').classList.toggle('hidden', !isPage || !isMd);
    $('html-edit-btn').classList.toggle('hidden', !isHtml);
    if (isHtml) {
      // Reset edit btn label on each navigation
      $('html-edit-btn').textContent = '✏️ Edit HTML';
    }

    if (page.type === 'folder') {
      renderFolderView(page, content);
    } else if (page.file_type === 'md') {
      renderWysiwygEditor(page, content);
    } else if (page.file_type === 'html') {
      renderHtmlEditor(page, content);
    }
  } catch (err) {
    content.innerHTML = `<div class="fade-in" style="text-align:center;padding:60px 0;color:var(--danger);">Failed to load: ${esc((err as Error).message)}</div>`;
  }
}

function updateTopbar(page: PageNode): void {
  const parent = state.pages.find(p => p.id === page.parent_id);
  $('bc-parent').textContent = parent ? (parent.display_name || parent.name) : 'yoınko';
  ($('page-title') as HTMLInputElement).value = page.display_name || page.name;
  $('topbar-badge').textContent = page.type === 'folder' ? 'folder' : (page.file_type || 'md');
}

// No-op stubs kept for API safety
function toggleEditMode(): void {}
function updatePreviewToggleBtn(): void {}

// ── WYSIWYG Editor (TipTap — loaded from local bundle) ───────────────────────

function tiptapToMarkdown(doc: TipTapDoc): string {
  function inline(nodes?: TipTapDoc[]): string {
    if (!nodes) return '';
    return nodes.map(n => {
      let t = n.text || '';
      if (n.marks) {
        n.marks.forEach(m => {
          if (m.type === 'bold') t = `**${t}**`;
          else if (m.type === 'italic') t = `*${t}*`;
          else if (m.type === 'strike') t = `~~${t}~~`;
          else if (m.type === 'code') t = `\`${t}\``;
          else if (m.type === 'link') t = `[${t}](${(m.attrs?.href as string) || ''})`;
        });
      }
      return t;
    }).join('');
  }

  function block(node: TipTapDoc, indent: string): string {
    indent = indent || '';
    const t = node.type;
    const c = node.content || [];
    if (t === 'doc') return c.map(n => block(n, '')).join('\n');
    if (t === 'paragraph') return indent + (inline(c) || '') + '\n';
    if (t === 'heading') return '#'.repeat(node.attrs?.level as number) + ' ' + inline(c) + '\n';
    if (t === 'horizontalRule') return '---\n';
    if (t === 'codeBlock') {
      const lang = (node.attrs?.language as string) || '';
      const code = c.map(n => n.text || '').join('');
      return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }
    if (t === 'blockquote') return c.map(n => '> ' + block(n, '').trimEnd()).join('\n') + '\n';
    if (t === 'bulletList') return c.map(n => block(n, '- ')).join('');
    if (t === 'orderedList') {
      let i = (node.attrs?.start as number) || 1;
      return c.map(n => block(n, `${i++}. `)).join('');
    }
    if (t === 'taskList') {
      return c.map(n => {
        const checked = n.attrs?.checked;
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
    return c.map(n => block(n, indent)).join('');
  }

  try {
    return block(doc, '').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  } catch {
    return '';
  }
}

function renderWysiwygEditor(page: PageNode, container: HTMLElement): void {
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

  if (state.wysiwyg) {
    try { state.wysiwyg.destroy(); } catch { /* already destroyed */ }
    state.wysiwyg = null;
  }

  if (!window.TipTapBundle) {
    showToast('Editor bundle not loaded — please refresh', 'error');
    console.error('TipTapBundle not found on window');
    return;
  }

  const { Editor, Extension, InputRule, StarterKit, TaskList, TaskItem, Placeholder } = window.TipTapBundle;

  const TaskBracketRule = Extension.create({
    name: 'taskBracketRule',
    addInputRules() {
      return [
        new InputRule({
          find: /^\[\]\s$/,
          handler: ({ chain, range }: { chain: () => { deleteRange: (r: unknown) => { toggleTaskList: () => { run: () => void } } }; range: unknown }) => {
            chain().deleteRange(range).toggleTaskList().run();
          },
        }),
      ];
    },
  });

  const initialHtml = page.content ? renderMarkdown(page.content) : '';

  const editor = new Editor({
    element: $('wysiwyg-editor'),
    extensions: [
      (StarterKit as { configure: (opts: Record<string, unknown>) => unknown }).configure({
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
    onUpdate({ editor }: { editor: { getJSON: () => TipTapDoc } }) {
      const md = tiptapToMarkdown(editor.getJSON());
      debounceSave(md);
      if (state.currentPage) state.currentPage.content = md;
    },
  });

  state.wysiwyg = editor;

  $('wysiwyg-editor').addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if ((ke.metaKey || ke.ctrlKey) && ke.key === 's') {
      ke.preventDefault();
      savePage(tiptapToMarkdown(editor.getJSON()));
    }
  }, true);
}

function renderHtmlEditor(page: PageNode, container: HTMLElement): void {
  // Default: preview-only (full-width iframe)
  container.className = 'content-area fade-in';
  container.innerHTML = `
    <iframe class="html-preview-frame" id="html-preview-frame" style="width:100%;height:100%;border:none;display:block"></iframe>
  `;
  const frame = $('html-preview-frame') as HTMLIFrameElement;
  frame.srcdoc = page.content || '<p>Empty page</p>';
}

function toggleHtmlEditMode(): void {
  const container = $('content-area');
  const page = state.currentPage;
  if (!page) return;

  const isEditing = container.classList.contains('editor-mode');

  if (isEditing) {
    // Switch back to preview-only
    container.className = 'content-area fade-in';
    container.innerHTML = `
      <iframe class="html-preview-frame" id="html-preview-frame" style="width:100%;height:100%;border:none;display:block"></iframe>
    `;
    ($('html-preview-frame') as HTMLIFrameElement).srcdoc = page.content || '<p>Empty page</p>';
    $('html-edit-btn').textContent = '✏️ Edit HTML';
  } else {
    // Switch to split editor + preview
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
    const textarea = $('editor-textarea') as HTMLTextAreaElement;
    const frame = $('html-preview-frame') as HTMLIFrameElement;
    const updateFrame = () => { frame.srcdoc = textarea.value || '<p>Empty page</p>'; };
    textarea.addEventListener('input', () => { updateFrame(); debounceSave(textarea.value); if (page) page.content = textarea.value; });
    textarea.addEventListener('keydown', (e: KeyboardEvent) => {
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
    $('html-edit-btn').textContent = '👁 Preview';
  }
}

// ── Auto-save ─────────────────────────────────────────────────────────────────
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function debounceSave(content: string): void {
  clearTimeout(saveTimer);
  showSavingState();
  saveTimer = setTimeout(() => savePage(content), 1000);
}

async function savePage(content: string): Promise<void> {
  if (!state.currentPageId) return;
  clearTimeout(saveTimer);
  showSavingState();
  try {
    await api.updatePage(state.currentPageId, { content });
    if (state.currentPage) state.currentPage.content = content;
    showSavedState();
  } catch (err) {
    showToast('Save failed: ' + (err as Error).message, 'error');
    hideSaveState();
  }
}

function showSavingState(): void {
  $('saving-indicator')?.classList.remove('hidden');
  $('save-indicator')?.classList.add('hidden');
}
function showSavedState(): void {
  $('saving-indicator')?.classList.add('hidden');
  const saved = $('save-indicator');
  saved?.classList.remove('hidden');
  setTimeout(() => saved?.classList.add('hidden'), 2500);
}
function hideSaveState(): void {
  $('saving-indicator')?.classList.add('hidden');
  $('save-indicator')?.classList.add('hidden');
}

// ── Folder view ───────────────────────────────────────────────────────────────
function renderFolderView(page: PageNode, container: HTMLElement): void {
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
        <div class="folder-actions" style="margin-bottom:12px;">
          <button class="btn btn-sm btn-ghost" onclick="openNewPageModal('page','${page.id}')">📝 Add Page</button>
          <button class="btn btn-sm btn-ghost" onclick="openNewPageModal('folder','${page.id}')">📁 Add Folder</button>
          <button class="btn btn-sm btn-ghost" onclick="openNewPageModal('image')">🖼️ Add Image</button>
        </div>
        <div class="folder-num">SECTION ${sectionNum}</div>
        <h1 class="folder-title" style="margin:0">${esc(displayName)}</h1>
        <p class="folder-meta">${children.length + (page.assets?.length || 0)} item${(children.length + (page.assets?.length || 0)) !== 1 ? 's' : ''}</p>
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
                <div class="child-card-meta">${child.type === 'folder' ? `${(state.pages.filter(p => p.parent_id === child.id).length + ((child as any).asset_count || 0))} items` : ext.toUpperCase() || 'MD'}</div>
              </div>
            `;
          }).join('')}
        </div>
      ` : `
        <div style="color:var(--text-dim);font-size:14px;padding:20px 0;">
          This folder is empty.
          <a href="#" onclick="openNewPageModal('page');return false;" style="color:var(--tomato);text-decoration:none;font-weight:600;">Add a page</a> to get started.
        </div>
      `}

      ${renderAssetsSection(page)}
      ${renderUploadZone(page.id)}
    </div>
  `;
  setupUploadZone(page.id);
}

// ── Assets ────────────────────────────────────────────────────────────────────
function renderAssetsSection(page: PageNode): string {
  const assets = page.assets || [];
  if (!assets.length) return '';

  const imgs = assets.filter((a: Asset) => a.mime_type?.startsWith('image/'));
  const files = assets.filter((a: Asset) => !a.mime_type?.startsWith('image/'));

  return `
    <div class="assets-section">
      ${imgs.length ? `
        <div class="section-heading">Images &amp; Media · ${imgs.length}</div>
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
                <div class="asset-type">${(a.size / 1024).toFixed(1)} KB</div>
              </div>
            </div>
          `).join('')}
        </div>
      ` : ''}
      ${files.length ? `
        <div class="section-heading" style="margin-top:${imgs.length ? '24px' : 0}">Files · ${files.length}</div>
        ${files.map(a => {
          const ext = a.original_name.split('.').pop()?.toUpperCase() || '';
          return `
            <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;display:flex;align-items:center;gap:12px;margin-bottom:7px;">
              <div style="font-size:24px;flex-shrink:0">📄</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.original_name)}</div>
                <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim)">${ext} · ${(a.size / 1024).toFixed(1)} KB</div>
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

function renderUploadZone(pageId: string): string {
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

function setupUploadZone(pageId: string): void {
  const zone = $(`upload-zone-${pageId}`);
  if (!zone) return;
  zone.addEventListener('dragover', (e: Event) => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', (e: Event) => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    uploadFiles((e as DragEvent).dataTransfer!.files, pageId);
  });
}

function triggerUpload(pageId: string): void {
  ($(`upload-input-${pageId}`) as HTMLInputElement)?.click();
}

function handleFileUpload(e: Event, pageId: string): void {
  uploadFiles((e.target as HTMLInputElement).files!, pageId);
}

async function uploadFiles(files: FileList, pageId: string): Promise<void> {
  if (!files.length) return;
  showToast(`Uploading ${files.length} file(s)…`);
  const form = new FormData();
  for (const f of Array.from(files)) form.append('files', f);
  form.append('page_id', pageId);
  try {
    await api.uploadFiles(form);
    showToast('Uploaded!');
    await renderPage(pageId);
  } catch (err) {
    showToast('Upload failed: ' + (err as Error).message, 'error');
  }
}

let _confirmDeleteResolve: ((v: boolean) => void) | null = null;

function showConfirmDelete(filename?: string, title = 'Delete asset?'): Promise<boolean> {
  return new Promise(resolve => {
    _confirmDeleteResolve = resolve;
    const titleEl = document.getElementById('confirm-delete-title');
    if (titleEl) titleEl.textContent = title;
    const msg = $('confirm-delete-msg');
    if (msg) msg.textContent = filename ? `“${filename}” will be permanently deleted.` : 'This action cannot be undone.';
    $('confirm-delete-overlay').classList.add('open');
  });
}

function closeConfirmDelete(result: boolean): void {
  $('confirm-delete-overlay').classList.remove('open');
  if (_confirmDeleteResolve) { _confirmDeleteResolve(result); _confirmDeleteResolve = null; }
}

async function deleteAsset(assetId: string): Promise<void> {
  const confirmed = await showConfirmDelete();
  if (!confirmed) return;
  try {
    await api.deleteAsset(assetId);
    showToast('Deleted');
    if (state.currentPageId) await renderPage(state.currentPageId);
  } catch (err) {
    showToast('Delete failed: ' + (err as Error).message, 'error');
  }
}

// ── Create page/folder modal ──────────────────────────────────────────────────
let _ctxFolderId: string | null = null;

function openNewPageModal(defaultType: 'page' | 'folder' | 'image' = 'page', ctxFolderId?: string): void {
  _ctxFolderId = ctxFolderId || null;
  $('new-page-overlay').classList.add('open');
  ($('new-page-type') as HTMLSelectElement).value = defaultType;
  updateTypeOptions(defaultType);
  ($('new-page-name') as HTMLInputElement).value = '';
  ($('new-page-ai-prompt') as HTMLInputElement).value = '';
  ($('new-page-image-prompt') as HTMLTextAreaElement).value = '';
  $('new-page-ai-section').style.display = 'none';
  $('new-page-image-section').style.display = defaultType === 'image' ? '' : 'none';
  populateParentSelect(defaultType);
  ($('new-page-name') as HTMLInputElement).focus();
}

function populateParentSelect(type: string): void {
  const select = $('new-page-parent') as HTMLSelectElement;
  const folders = state.pages.filter(p => p.type === 'folder');
  select.innerHTML = '<option value="">— Root level —</option>';
  folders.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.id;
    opt.textContent = f.display_name || f.name;
    select.appendChild(opt);
  });
  if (type === 'page') {
    // Priority: explicit ctx folder → current folder → parent of current page → root
    const ctxId = _ctxFolderId
      || (state.currentPage?.type === 'folder' ? state.currentPage.id : null)
      || state.currentPage?.parent_id
      || '';
    select.value = ctxId || '';
  }
}

function closeNewPageModal(): void {
  $('new-page-overlay').classList.remove('open');
}

function updateTypeOptions(type: string): void {
  $$('.type-option').forEach(opt => opt.classList.toggle('selected', opt.dataset.type === type));
  const isFolder = type === 'folder';
  const isImage  = type === 'image';
  $('new-page-file-type-row').style.display  = (isFolder || isImage) ? 'none' : '';
  $('new-page-parent-row').style.display     = (isFolder || isImage) ? 'none' : '';
  $('new-page-ai-prefill-row').style.display = isImage ? 'none' : '';
  $('new-page-ai-section').style.display     = 'none';
  $('new-page-image-section').style.display  = isImage ? '' : 'none';
  // Update name field label + placeholder to match context
  const nameInput = $('new-page-name') as HTMLInputElement;
  const nameLabel = nameInput.previousElementSibling as HTMLLabelElement;
  if (isImage) {
    nameInput.placeholder = 'Image name\u2026';
    if (nameLabel) nameLabel.textContent = 'Name';
  } else if (isFolder) {
    nameInput.placeholder = 'Folder name\u2026';
    if (nameLabel) nameLabel.textContent = 'Name';
  } else {
    nameInput.placeholder = 'Page name\u2026';
    if (nameLabel) nameLabel.textContent = 'Name';
  }
  if (isImage) {
    setTimeout(() => ($('new-page-image-prompt') as HTMLTextAreaElement).focus(), 50);
  }
}

function selectType(type: 'page' | 'folder'): void {
  ($('new-page-type') as HTMLSelectElement).value = type;
  updateTypeOptions(type);
}

function toggleAiFill(): void {
  const section = $('new-page-ai-section');
  const isHidden = section.style.display === 'none' || !section.style.display;
  section.style.display = isHidden ? '' : 'none';
  if (isHidden) ($('new-page-ai-prompt') as HTMLInputElement).focus();
}

async function submitNewPage(): Promise<void> {
  const rawName = ($('new-page-name') as HTMLInputElement).value.trim();
  const type = ($('new-page-type') as HTMLSelectElement).value as 'page' | 'folder' | 'image';
  const fileType = ($('new-page-file-type') as HTMLSelectElement).value;
  const aiPrompt = ($('new-page-ai-prompt') as HTMLInputElement).value.trim();
  const imagePrompt = ($('new-page-image-prompt') as HTMLTextAreaElement).value.trim();

  if (type === 'image') {
    if (!imagePrompt) { showToast('Please describe the image', 'error'); return; }
    const btn = $('new-page-submit') as HTMLButtonElement;
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
      showToast('Generating image… ⏳');
      const page_id = state.currentPageId ?? undefined;
      await api.generateImg({ prompt: imagePrompt, page_id });
      closeNewPageModal();
      if (state.currentPageId) await renderPage(state.currentPageId);
      showToast('Image generated!');
    } catch (err) {
      showToast('Failed: ' + (err as Error).message, 'error');
    } finally {
      btn.disabled = false; btn.textContent = 'Create';
    }
    return;
  }

  if (!rawName) { showToast('Please enter a name', 'error'); return; }

  let parentId: string | null = null;
  let finalName = rawName;

  if (type === 'folder') {
    if (_ctxFolderId) {
      // Child folder — created inside a specific parent, no auto-prefix
      parentId = _ctxFolderId;
      finalName = rawName;
    } else {
      // Top-level folder — auto-prefix with next sequential number
      parentId = null;
      const topFolders = state.pages.filter(p => p.type === 'folder' && !p.parent_id);
      const nextNum = String(topFolders.length + 1).padStart(2, '0');
      finalName = `${nextNum} - ${rawName}`;
    }
  } else {
    // Use the location dropdown value
    const sel = ($('new-page-parent') as HTMLSelectElement).value;
    parentId = sel || null;
  }

  const btn = $('new-page-submit') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    let content = '';

    if (type === 'page' && aiPrompt) {
      showToast('Generating content with AI… ⏳');
      const { content: gen } = await api.generate({ prompt: aiPrompt, type: fileType as 'md' | 'html' });
      content = gen;
    }

    const { page } = await api.createPage({
      name: finalName,
      type,
      file_type: type === 'folder' ? undefined : fileType,
      parent_id: parentId,
      content,
    });
    closeNewPageModal();
    await loadPages();
    if (type === 'folder') {
      // Refresh the parent view (child folder) or navigate to the new top-level folder
      const targetId = parentId || page.id;
      if (state.currentPageId === targetId) {
        // Already viewing the parent — force re-render
        await renderPage(targetId);
        renderSidebar();
      } else {
        await navigateTo(targetId);
      }
    } else {
      await navigateTo(page.id);
    }
    showToast(`${type === 'folder' ? 'Folder' : 'Page'} created!`);
  } catch (err) {
    showToast('Failed: ' + (err as Error).message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create';
  }
}

// ── Welcome screen ────────────────────────────────────────────────────────────
function showWelcome(): void {
  state.currentPageId = null;
  state.currentPage = null;
  state.editMode = false;
  const content = $('content-area');
  content.className = 'content-area';
  content.innerHTML = `
    <div class="welcome-state fade-in">
      <div class="welcome-icon">✦</div>
      <h1 class="welcome-title">Welcome to yoınko</h1>
      <p class="welcome-sub">
        Create folders and pages to organize your knowledge.<br>
        All pages are stored as <strong>.md</strong> and <strong>.html</strong> files in <code style="font-family:'JetBrains Mono',monospace;font-size:13px;background:var(--butter);padding:2px 6px;border-radius:4px;">data/pages/</code>
      </p>
      <div style="display:flex;gap:10px;margin-top:8px;">
        <button class="btn btn-primary" onclick="openNewPageModal('folder')">📁 New Folder</button>
        <button class="btn btn-ghost" onclick="openNewPageModal('page')">📝 New Page</button>
      </div>
    </div>
  `;
  $('topbar-badge').textContent = '';
  ($('page-title') as HTMLInputElement).value = '';
  $('bc-parent').textContent = 'yoınko';
  $('compose-btn').classList.add('hidden');
  $('edit-toggle-btn').classList.add('hidden');
  hideSaveState();
}

// ── Rename / Delete (custom modals) ──────────────────────────────────────────
let _renameId = '';
let _deleteId = '';

function renamePagePrompt(id: string, currentDisplayName: string): void {
  _renameId = id;
  const input = $('rename-input') as HTMLInputElement;
  input.value = currentDisplayName;
  $('rename-overlay').classList.add('open');
  // Focus after transition
  setTimeout(() => input.select(), 80);
  // Allow Enter key to submit
  input.onkeydown = (e) => { if (e.key === 'Enter') submitRename(); if (e.key === 'Escape') $('rename-overlay').classList.remove('open'); };
}

async function submitRename(): Promise<void> {
  const newName = ($('rename-input') as HTMLInputElement).value.trim();
  if (!newName) return;
  $('rename-overlay').classList.remove('open');
  try {
    await api.updatePage(_renameId, { name: newName });
    await loadPages();
    if (state.currentPageId === _renameId && state.currentPage) {
      state.currentPage.display_name = newName;
      ($('page-title') as HTMLInputElement).value = newName;
    }
    showToast('Renamed!');
  } catch (err) {
    showToast('Rename failed: ' + (err as Error).message, 'error');
  }
}

function deletePageConfirm(id: string, name: string): void {
  _deleteId = id;
  ($('delete-page-name') as HTMLElement).textContent = `"${name}"`;
  $('delete-overlay').classList.add('open');
}

async function submitDelete(): Promise<void> {
  $('delete-overlay').classList.remove('open');
  try {
    await api.deletePage(_deleteId);
    await loadPages();
    if (state.currentPageId === _deleteId) showWelcome();
    showToast('Deleted.');
  } catch (err) {
    showToast('Delete failed: ' + (err as Error).message, 'error');
  }
}

// ── Context menu ──────────────────────────────────────────────────────────────
const ctxMenu = document.createElement('div');
ctxMenu.className = 'ctx-menu';
ctxMenu.id = 'ctx-menu';
document.body.appendChild(ctxMenu);

function showCtxMenu(e: Event, page: PageNode): void {
  e.preventDefault();
  const displayName = page.display_name || page.name;
  ctxMenu.innerHTML = `
    <div class="ctx-menu-item" onclick="renamePagePrompt('${page.id}','${esc(displayName)}')">✏️ Rename</div>
    ${page.type === 'folder' ? `
      <div class="ctx-menu-item" onclick="openNewPageModal('page','${page.id}')">📄 Add Page Inside</div>
      <div class="ctx-menu-item" onclick="openNewPageModal('folder','${page.id}')">📁 Add Folder Inside</div>
    ` : ''}
    <div class="ctx-menu-sep"></div>
    <div class="ctx-menu-item danger" onclick="deletePageConfirm('${page.id}','${esc(displayName)}')">🗑 Delete</div>
  `;
  ctxMenu.style.left = `${Math.min((e as MouseEvent).clientX, window.innerWidth - 180)}px`;
  ctxMenu.style.top = `${Math.min((e as MouseEvent).clientY, window.innerHeight - 120)}px`;
  ctxMenu.classList.add('open');
}

document.addEventListener('click', () => ctxMenu.classList.remove('open'));




// ── Page title inline editing ─────────────────────────────────────────────────
let titleTimer: ReturnType<typeof setTimeout> | undefined;

function onTitleChange(e: Event): void {
  clearTimeout(titleTimer);
  titleTimer = setTimeout(async () => {
    if (!state.currentPageId) return;
    const val = (e.target as HTMLInputElement).value.trim();
    if (!val) return;
    try {
      const res = await api.updatePage(state.currentPageId, { name: val });
      if (res.page?.id && res.page.id !== state.currentPageId) {
        state.currentPageId = res.page.id;
        window.location.hash = `page/${res.page.id}`;
      }
      await loadPages();
    } catch { /* silently fail */ }
  }, 900);
}

// ── Compose (+ button AI section) ─────────────────────────────────────────────
function openCompose(): void {
  $('compose-popup').classList.toggle('open');
  ($('compose-input') as HTMLInputElement).focus();
}

async function submitCompose(): Promise<void> {
  const prompt = ($('compose-input') as HTMLInputElement).value.trim();
  if (!prompt || !state.currentPage) return;

  const btn = $('compose-submit') as HTMLButtonElement;
  btn.disabled = true;
  btn.textContent = 'Generating…';

  try {
    const { content: newSection } = await api.generate({
      prompt,
      type: state.currentPage.file_type || 'md',
      context: (state.currentPage.content || '').slice(0, 1500),
    });
    const sep = state.currentPage.file_type === 'html' ? '\n\n<!-- section -->\n' : '\n\n---\n\n';
    const newContent = (state.currentPage.content || '') + sep + newSection;
    await api.updatePage(state.currentPageId!, { content: newContent });
    state.currentPage.content = newContent;
    $('compose-popup').classList.remove('open');
    ($('compose-input') as HTMLInputElement).value = '';
    await renderPage(state.currentPageId!);
    showToast('Section added!');
  } catch (err) {
    showToast('AI failed: ' + (err as Error).message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '✨ Generate';
  }
}

// ── Chat drawer ───────────────────────────────────────────────────────────────
function toggleChat(): void {
  state.chatOpen = !state.chatOpen;
  $('chat-drawer').classList.toggle('open', state.chatOpen);
  if (state.chatOpen && state.currentPageId) loadChatHistory();
}

async function loadChatHistory(): Promise<void> {
  if (!state.currentPageId) return;
  try {
    const { messages } = await api.getChatHistory(state.currentPageId);
    state.chatMessages = messages.map(m => ({ role: m.role as LLMMessage['role'], content: m.content }));
    renderChatMessages();
  } catch { /* silently fail */ }
}

function renderChatMessages(): void {
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

function renderMarkdownSimple(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, m => `<pre style="background:var(--surface-3);padding:8px;border-radius:6px;font-size:12px;overflow-x:auto;margin:6px 0"><code>${esc(m.slice(3, -3).replace(/^[^\n]*\n/, ''))}</code></pre>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');
}

async function sendChatMessage(): Promise<void> {
  const input = $('chat-input') as HTMLTextAreaElement;
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
  ($('chat-send-btn') as HTMLButtonElement).disabled = true;

  let reply = '';
  const pageContent = state.currentPage?.content || '';

  await api.chatStream(
    state.chatMessages.filter(m => m.role !== 'system'),
    state.currentPageId,
    pageContent,
    {
      onChunk: (chunk) => {
        reply += chunk;
        const el = document.getElementById(typingId);
        if (el) {
          const inner = el.querySelector('.chat-msg-content, .chat-typing');
          if (inner) inner.outerHTML = `<div class="chat-msg-content">${renderMarkdownSimple(reply)}</div>`;
        }
        $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
      },
      onDone: () => {
        state.chatMessages.push({ role: 'assistant', content: reply });
        state.chatStreaming = false;
        ($('chat-send-btn') as HTMLButtonElement).disabled = false;
        renderChatMessages();
      },
      onError: (err) => {
        state.chatStreaming = false;
        ($('chat-send-btn') as HTMLButtonElement).disabled = false;
        showToast('Chat error: ' + err, 'error');
        document.getElementById(typingId)?.remove();
      },
    }
  );
}

function clearChat(): void {
  state.chatMessages = [];
  renderChatMessages();
}

async function applyAiSuggestion(): Promise<void> {
  if (!state.chatMessages.length || !state.currentPageId) return;
  const last = [...state.chatMessages].reverse().find(m => m.role === 'assistant');
  if (!last) return;
  const isMd = state.currentPage?.file_type === 'md';
  const sep = isMd ? '\n\n---\n\n' : '\n\n<!-- section -->\n\n';
  const newContent = (state.currentPage?.content || '') + sep + last.content;
  try {
    await api.updatePage(state.currentPageId, { content: newContent });
    if (state.currentPage) state.currentPage.content = newContent;
    await renderPage(state.currentPageId);
    showToast('Content applied!');
  } catch { /* silently fail */ }
}

// ── Settings modal ────────────────────────────────────────────────────────────
async function openSettings(): Promise<void> {
  $('settings-overlay').classList.add('open');
  try {
    const { settings } = await api.getSettings();
    state.settings = settings;
    ($('settings-provider') as HTMLSelectElement).value = settings.llm_provider || 'openai';
    ($('settings-model') as HTMLInputElement).value = settings.llm_model || '';
    ($('settings-api-key') as HTMLInputElement).value = '';
    ($('settings-api-key') as HTMLInputElement).placeholder = (settings as Record<string, string>).llm_api_key_masked || 'Enter API key…';
    ($('settings-base-url') as HTMLInputElement).value = settings.llm_base_url || '';
    const knownModels = ['dall-e-3', 'dall-e-2', 'imagen-3'];
    const savedModel = settings.image_model || 'dall-e-3';
    const isCustom = !knownModels.includes(savedModel);
    const selectEl = $('settings-image-model') as HTMLSelectElement;
    selectEl.value = isCustom ? '__custom__' : savedModel;
    toggleCustomImageModel(selectEl.value);
    if (isCustom) {
      ($('settings-image-model-custom') as HTMLInputElement).value = savedModel;
    }
    updateProviderCards(settings.llm_provider || 'openai');
    updateProviderUI(settings.llm_provider || 'openai');
    updateActiveProviderLabel(settings.llm_provider || 'openai');
  } catch {
    showToast('Failed to load settings', 'error');
  }
}

function closeSettings(): void {
  $('settings-overlay').classList.remove('open');
}

function selectProvider(p: string): void {
  ($('settings-provider') as HTMLSelectElement).value = p;
  updateProviderCards(p);
  updateProviderUI(p);
  updateActiveProviderLabel(p);
  const defaults: Record<string, string> = {
    openai: 'gpt-4o-mini',
    gemini: 'gemini-2.0-flash',
    claude: 'claude-3-5-haiku-20241022',
    'openai-compatible': '',
  };
  const modelEl = $('settings-model') as HTMLInputElement;
  if (!modelEl.value) modelEl.value = defaults[p] || '';
}

function updateProviderCards(p: string): void {
  $$('.provider-card').forEach(c => c.classList.toggle('selected', c.dataset.provider === p));
}

function updateProviderUI(p: string): void {
  $('base-url-row').style.display = p === 'openai-compatible' ? '' : 'none';
}

function updateActiveProviderLabel(p: string): void {
  const labels: Record<string, string> = {
    openai: 'OpenAI',
    gemini: 'Google Gemini',
    claude: 'Anthropic Claude',
    'openai-compatible': 'OpenAI Compatible',
  };
  const el = $('active-provider-label');
  if (el) el.textContent = labels[p] || p;
}

async function saveSettings(): Promise<void> {
  const selectVal = ($('settings-image-model') as HTMLSelectElement).value;
  const imageModel = selectVal === '__custom__'
    ? ($('settings-image-model-custom') as HTMLInputElement).value.trim() || 'dall-e-3'
    : selectVal;
  const updates: Partial<Settings> & Record<string, string> = {
    llm_provider: ($('settings-provider') as HTMLSelectElement).value as Settings['llm_provider'],
    llm_model: ($('settings-model') as HTMLInputElement).value,
    llm_base_url: ($('settings-base-url') as HTMLInputElement).value,
    image_model: imageModel,
  };
  const key = ($('settings-api-key') as HTMLInputElement).value;
  if (key) updates.llm_api_key = key;
  try {
    await api.saveSettings(updates);
    closeSettings();
    showToast('Settings saved!');
  } catch (err) {
    showToast('Save failed: ' + (err as Error).message, 'error');
  }
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function toggleCustomImageModel(val: string): void {
  $('custom-image-model-row').style.display = val === '__custom__' ? '' : 'none';
  if (val === '__custom__') {
    setTimeout(() => ($('settings-image-model-custom') as HTMLInputElement).focus(), 50);
  }
}

function openLightbox(src: string, name: string): void {
  ($('lightbox-img') as HTMLImageElement).src = src;
  $('lightbox-name').textContent = name || '';
  $('lightbox').classList.add('open');
}
function closeLightbox(): void {
  $('lightbox').classList.remove('open');
}

// ── Clipboard ─────────────────────────────────────────────────────────────────
async function copyToClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(window.location.origin + text);
    showToast('URL copied!');
  } catch {
    showToast('Copy failed', 'error');
  }
}

// ── Toast ─────────────────────────────────────────────────────────────────────
let toastTimer: ReturnType<typeof setTimeout> | undefined;

function showToast(msg: string, type: 'info' | 'error' = 'info'): void {
  const toast = $('toast');
  toast.querySelector('.toast-text')!.textContent = msg;
  toast.className = `toast ${type === 'error' ? 'error' : ''} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3500);
}

// ── Search ────────────────────────────────────────────────────────────────────
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function onSearch(): void {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderSidebar(), 200);
}

// ── Markdown render helper ────────────────────────────────────────────────────
function renderMarkdown(text: string): string {
  if (typeof marked === 'undefined') return `<pre>${esc(text || '')}</pre>`;
  const result = marked.parse(text || '', { async: false });
  const html = typeof result === 'string' ? result : `<pre>${esc(text || '')}</pre>`;
  // Convert marked's checkbox <li> items into TipTap taskList/taskItem format
  return html
    .replace(
      /<ul>\s*(<li>\s*<input[^>]*type="checkbox"[^>]*>[\s\S]*?<\/li>\s*)<\/ul>/g,
      (_, items) => {
        const converted = items.replace(
          /<li>\s*<input([^>]*)type="checkbox"([^>]*)>([\s\S]*?)<\/li>/g,
          (_m: string, pre: string, post: string, content: string) => {
            const checked = (pre + post).includes('checked') ? 'data-checked="true"' : 'data-checked="false"';
            return `<li data-type="taskItem" ${checked}><label><input type="checkbox" ${(pre+post).includes('checked') ? 'checked' : ''}><span>${content.trim()}</span></label></li>`;
          }
        );
        return `<ul data-type="taskList">${converted}</ul>`;
      }
    );
}

// ── HTML escape ───────────────────────────────────────────────────────────────
function esc(str: string | null | undefined): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Event listeners ───────────────────────────────────────────────────────────
function setupEventListeners(): void {
  $('theme-btn')?.addEventListener('click', toggleTheme);
  $('sidebar-search').addEventListener('input', onSearch);
  $('btn-new-page').addEventListener('click', () => openNewPageModal('page'));
  $('btn-new-folder').addEventListener('click', () => openNewPageModal('folder'));
  $('settings-btn').addEventListener('click', openSettings);
  $('chat-toggle').addEventListener('click', toggleChat);
  $('chat-close-btn').addEventListener('click', toggleChat);

  ($('chat-input') as HTMLTextAreaElement).addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChatMessage(); }
  });
  ($('chat-input') as HTMLTextAreaElement).addEventListener('input', function (this: HTMLTextAreaElement) {
    this.style.height = 'auto';
    this.style.height = Math.min(this.scrollHeight, 120) + 'px';
  });

  $('compose-btn').addEventListener('click', openCompose);
  ($('compose-input') as HTMLInputElement).addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitCompose();
    if (e.key === 'Escape') $('compose-popup').classList.remove('open');
  });

  document.addEventListener('click', (e: MouseEvent) => {
    if (!(e.target as Element).closest('.compose-popup') && !(e.target as Element).closest('#compose-btn')) {
      $('compose-popup').classList.remove('open');
    }
  });

  $('confirm-delete-cancel').addEventListener('click', () => closeConfirmDelete(false));
  $('confirm-delete-ok').addEventListener('click', () => closeConfirmDelete(true));
  $('confirm-delete-overlay').addEventListener('click', (e: MouseEvent) => { if (e.target === $('confirm-delete-overlay')) closeConfirmDelete(false); });

  $('new-page-overlay').addEventListener('click', (e: MouseEvent) => { if (e.target === $('new-page-overlay')) closeNewPageModal(); });
  $('settings-overlay').addEventListener('click', (e: MouseEvent) => { if (e.target === $('settings-overlay')) closeSettings(); });
  $('lightbox').addEventListener('click', (e: MouseEvent) => { if (e.target === $('lightbox')) closeLightbox(); });
  $('create-project-overlay').addEventListener('click', (e: MouseEvent) => { if (e.target === $('create-project-overlay')) closeCreateProjectModal(); });
  $('rename-project-overlay').addEventListener('click', (e: MouseEvent) => { if (e.target === $('rename-project-overlay')) closeRenameProjectModal(); });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeLightbox();
      closeConfirmDelete(false);
      closeCreateProjectModal();
      closeRenameProjectModal();
      $('compose-popup').classList.remove('open');
    }
  });

  $('page-title').addEventListener('input', onTitleChange);
  ($('new-page-type') as HTMLSelectElement).addEventListener('change', (e: Event) => updateTypeOptions((e.target as HTMLSelectElement).value));

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'p' && !(e.target as Element).closest('.notion-textarea, #editor-textarea, #chat-input, .form-input, .form-textarea')) {
      e.preventDefault();
      if (state.currentPage && state.currentPage.file_type === 'md') toggleEditMode();
    }
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', init);
