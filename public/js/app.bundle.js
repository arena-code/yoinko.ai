"use strict";
var NotasApp = (() => {
  // src/client/api.ts
  var API_BASE = "/api";
  var _currentProjectId = localStorage.getItem("yoinko_project") ?? "default";
  function getCurrentProjectId() {
    return _currentProjectId;
  }
  function setCurrentProjectId(id) {
    _currentProjectId = id;
    localStorage.setItem("yoinko_project", id);
  }
  var _logoutTriggered = false;
  function handleAuthFailure() {
    if (!_logoutTriggered) {
      _logoutTriggered = true;
      try {
        localStorage.clear();
      } catch {
      }
      try {
        sessionStorage.clear();
      } catch {
      }
      window.location.replace("/auth/logout");
    }
    throw new Error("Session expired \u2014 signing out\u2026");
  }
  async function request(method, path, body, isFormData = false) {
    const headers = isFormData ? { "X-Project-Id": _currentProjectId } : { "Content-Type": "application/json", "X-Project-Id": _currentProjectId };
    const opts = { method, headers };
    if (body !== void 0) {
      opts.body = isFormData ? body : JSON.stringify(body);
    }
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (res.status === 401 || res.status === 403) {
      handleAuthFailure();
    }
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return res.json();
  }
  var api = {
    // ── Projects ───────────────────────────────────────────────────────────────
    listProjects: () => request("GET", "/projects"),
    createProject: (name) => request("POST", "/projects", { name }),
    renameProject: (id, name) => request("PATCH", `/projects/${id}`, { name }),
    deleteProject: (id) => request("DELETE", `/projects/${id}`),
    // ── Pages ──────────────────────────────────────────────────────────────────
    getTree: () => request("GET", "/pages"),
    getFlat: () => request("GET", "/pages/flat"),
    getPage: (id) => request("GET", `/pages/${id}`),
    createPage: (data) => request("POST", "/pages", data),
    updatePage: (id, data) => request("PUT", `/pages/${id}`, data),
    deletePage: (id) => request("DELETE", `/pages/${id}`),
    // ── Assets ─────────────────────────────────────────────────────────────────
    uploadFiles: (formData) => request("POST", "/assets/upload", formData, true),
    getAssets: (pageId) => request("GET", `/assets${pageId ? `?page_id=${pageId}` : ""}`),
    deleteAsset: (id) => request("DELETE", `/assets/${id}`),
    assetUrl: (id) => `${API_BASE}/assets/${id}/file`,
    // ── Settings ───────────────────────────────────────────────────────────────
    getSettings: () => request("GET", "/settings"),
    saveSettings: (data) => request("PUT", "/settings", data),
    // ── LLM Profiles ───────────────────────────────────────────────────────────
    getProfiles: () => request("GET", "/settings/profiles"),
    saveProfile: (profile) => request("PUT", "/settings/profiles", profile),
    deleteProfile: (id) => request("DELETE", `/settings/profiles/${id}`),
    setActiveProfile: (id) => request("PUT", "/settings/profiles/active", { id }),
    // ── MD Templates ───────────────────────────────────────────────────────────
    getTemplates: () => request("GET", "/settings/templates"),
    saveTemplate: (t) => request("PUT", "/settings/templates", t),
    deleteTemplate: (id) => request("DELETE", `/settings/templates/${id}`),
    // ── Move ───────────────────────────────────────────────────────────────────
    movePage: (id, targetParentId) => request("PUT", `/pages/${id}/move`, { target_parent_id: targetParentId }),
    moveAsset: (id, targetPageId) => request("PATCH", `/assets/${id}`, { page_id: targetPageId }),
    // ── AI ─────────────────────────────────────────────────────────────────────
    generate: (data) => request("POST", "/ai/generate", data),
    generateImg: (data) => request("POST", "/ai/image", data),
    getChatHistory: (pageId) => request("GET", `/ai/chat/history?page_id=${pageId}`),
    deleteChatHistory: (pageId) => request("DELETE", `/ai/chat/history?page_id=${pageId}`),
    // Streaming chat — Server-Sent Events via fetch
    async chatStream(messages, pageId, pageContent, { onChunk, onDone, onError }) {
      try {
        const res = await fetch(`${API_BASE}/ai/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Project-Id": _currentProjectId
          },
          body: JSON.stringify({ messages, page_id: pageId, page_content: pageContent })
        });
        if (res.status === 401 || res.status === 403) {
          handleAuthFailure();
          return;
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          onError(err.error ?? "Chat failed");
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === "chunk" && data.text) onChunk(data.text);
              else if (data.type === "done") onDone();
              else if (data.type === "error") onError(data.error ?? "Unknown error");
            } catch {
            }
          }
        }
      } catch (err) {
        onError(err.message);
      }
    }
  };

  // src/client/app.ts
  var state = {
    pages: [],
    projects: [],
    currentPageId: null,
    currentPage: null,
    theme: "dark",
    chatOpen: false,
    chatMessages: [],
    chatStreaming: false,
    expandedFolders: /* @__PURE__ */ new Set(),
    settings: {},
    wysiwyg: null,
    aiEnabled: false
  };
  var $ = (id) => document.getElementById(id);
  var $$ = (sel) => document.querySelectorAll(sel);
  var escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  function showMascotLoading(text = "Working on it\u2026", sub = "Yoyo is thinking") {
    $("mascot-loading-text").textContent = text;
    $("mascot-loading-sub").textContent = sub;
    $("mascot-loading").classList.add("active");
  }
  function hideMascotLoading() {
    $("mascot-loading").classList.remove("active");
  }
  async function init() {
    window.navigateTo = navigateTo;
    window.openNewPageModal = openNewPageModal;
    window.openLightbox = openLightbox;
    window.copyToClipboard = copyToClipboard;
    window.deleteAsset = deleteAsset;
    window.openAssetCardMenu = openAssetCardMenu;
    window.openChildCardMenu = openChildCardMenu;
    window.closeCardMenu = closeCardMenu;
    window.closeMoveModal = closeMoveModal;
    window.submitMove = submitMove;
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
    window.toggleHtmlEditMode = toggleHtmlEditMode;
    window.triggerUpload = triggerUpload;
    window.handleFileUpload = handleFileUpload;
    window.clearChat = clearChat;
    window.applyAiSuggestion = applyAiSuggestion;
    window.closeLightbox = closeLightbox;
    window.sendChatMessage = sendChatMessage;
    window.toggleChat = toggleChat;
    window.toggleSidebar = toggleSidebar;
    window.switchProject = switchProject;
    window.openCreateProjectModal = openCreateProjectModal;
    window.closeCreateProjectModal = closeCreateProjectModal;
    window.submitCreateProject = submitCreateProject;
    window.deleteProjectConfirm = deleteProjectConfirm;
    window.closeConfirmDeleteProject = closeConfirmDeleteProject;
    window.openRenameProjectModal = openRenameProjectModal;
    window.closeRenameProjectModal = closeRenameProjectModal;
    window.submitRenameProject = submitRenameProject;
    window.addNewProfile = addNewProfile;
    window.deleteCurrentProfile = deleteCurrentProfile;
    window.confirmDeleteProfile = confirmDeleteProfile;
    window.setActiveCurrentProfile = setActiveCurrentProfile;
    window.saveCurrentProfile = saveCurrentProfile;
    window.selectProfileItem = selectProfileItem;
    if (typeof marked !== "undefined") {
      marked.use({ gfm: true });
    }
    window.toggleProjectMenu = () => {
      const menu = document.getElementById("project-menu");
      if (menu) menu.classList.toggle("open");
    };
    window.cloudLogout = () => {
      try {
        localStorage.clear();
      } catch {
      }
      try {
        sessionStorage.clear();
      } catch {
      }
      window.location.replace("/auth/logout");
    };
    await loadSettings();
    applyTheme(state.theme);
    await applyAIVisibility();
    if (localStorage.getItem("yk-sidebar-collapsed") === "1") {
      $("sidebar").classList.add("collapsed");
    }
    await loadProjects();
    await loadPages();
    setupEventListeners();
    try {
      const healthRes = await fetch("/api/health");
      const health = await healthRes.json();
      if (health.cloud) {
        const userRow = document.getElementById("sidebar-user-row");
        if (userRow) userRow.style.display = "";
        try {
          const meRes = await fetch("/api/me");
          const me = await meRes.json();
          if (me.user) {
            const emailEl = document.getElementById("sidebar-user-email");
            const tenantEl = document.getElementById("sidebar-user-tenant");
            if (emailEl && me.user.email) emailEl.textContent = me.user.email;
            if (tenantEl && me.user.tenantId) tenantEl.textContent = me.user.tenantId + ".yoinko.ai";
          }
        } catch {
        }
      }
    } catch {
    }
    handleHashRoute();
    window.addEventListener("hashchange", handleHashRoute);
  }
  async function loadProjects() {
    try {
      const { projects } = await api.listProjects();
      state.projects = projects;
      const stored = getCurrentProjectId();
      if (!projects.find((p) => p.id === stored)) {
        setCurrentProjectId("default");
      }
      renderProjectSwitcher();
    } catch {
    }
  }
  function renderProjectSwitcher() {
    const switcher = document.getElementById("project-switcher");
    if (!switcher) return;
    const currentId = getCurrentProjectId();
    const current = state.projects.find((p) => p.id === currentId) ?? state.projects[0];
    const currentName = current?.name ?? "Default";
    const initials = (name) => name.slice(0, 2).toUpperCase();
    const hue = (name) => {
      let h = 0;
      for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360;
      return h;
    };
    const avatarStyle = (name, isDefault) => isDefault ? "" : `style="background: hsl(${hue(name)}, 60%, 48%)"`;
    switcher.innerHTML = `
    <button class="project-switcher-btn" onclick="toggleProjectMenu()" title="Switch project">
      <span class="project-switcher-avatar" ${avatarStyle(currentName, currentId === "default")}>${initials(currentName)}</span>
      <span class="project-switcher-name">${currentName}</span>
      <svg class="project-switcher-arrow" viewBox="0 0 20 20" fill="currentColor" width="12" height="12"><path fill-rule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
    </button>
    <div class="project-menu" id="project-menu">
      <div class="project-menu-label">Workspaces</div>
      ${state.projects.map((p) => {
      const isActive = p.id === currentId;
      return `
        <div class="project-menu-item${isActive ? " project-menu-item--active" : ""}"
             role="button" tabindex="0"
             onclick="switchProject('${p.id}')"
             onkeydown="if(event.key==='Enter'||event.key===' ')switchProject('${p.id}')">
          <span class="project-menu-avatar" ${avatarStyle(p.name, p.id === "default")}>${initials(p.name)}</span>
          <span class="project-menu-item-name">${p.name}</span>
          <span class="project-menu-actions">
                 <button class="project-menu-action-btn"
                         onclick="event.stopPropagation();openRenameProjectModal('${p.id}','${p.name}')"
                         title="Rename workspace">
                   <svg viewBox="0 0 12 12" fill="none" width="11" height="11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                     <path d="M8.5 1.5a1.414 1.414 0 012 2L3.5 10.5l-3 .5.5-3z"/>
                   </svg>
                 </button>
                 ${p.id !== "default" ? `<button class="project-menu-action-btn project-menu-action-delete"
                         onclick="event.stopPropagation();deleteProjectConfirm('${p.id}','${p.name}')"
                         title="Delete workspace">
                   <svg viewBox="0 0 10 10" fill="none" width="9" height="9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                     <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
                   </svg>
                 </button>` : ""}
               </span>
        </div>`;
    }).join("")}
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
  document.addEventListener("click", (e) => {
    const menu = document.getElementById("project-menu");
    const switcher = document.getElementById("project-switcher");
    if (menu?.classList.contains("open") && !switcher?.contains(e.target)) {
      menu.classList.remove("open");
    }
  });
  async function switchProject(id) {
    if (id === getCurrentProjectId()) return;
    setCurrentProjectId(id);
    document.getElementById("project-menu")?.classList.remove("open");
    state.currentPageId = null;
    state.currentPage = null;
    state.chatMessages = [];
    renderProjectSwitcher();
    await loadPages();
    const firstItem = state.pages.find((p) => !p.parent_id);
    if (firstItem) {
      await navigateTo(firstItem.id);
    } else {
      const contentArea = $("content-area");
      if (contentArea) contentArea.innerHTML = '<div class="empty-state"><p>This project is empty. Create a page to get started.</p></div>';
    }
    showToast(`Switched to ${state.projects.find((p) => p.id === id)?.name ?? id}`);
  }
  function openCreateProjectModal() {
    document.getElementById("project-menu")?.classList.remove("open");
    const overlay = document.getElementById("create-project-overlay");
    if (overlay) overlay.classList.add("open");
    const input = document.getElementById("new-project-name");
    if (input) {
      input.value = "";
      input.focus();
    }
  }
  function closeCreateProjectModal() {
    document.getElementById("create-project-overlay")?.classList.remove("open");
  }
  async function submitCreateProject() {
    const input = document.getElementById("new-project-name");
    const name = input?.value?.trim();
    if (!name) return;
    try {
      const { project } = await api.createProject(name);
      state.projects.push(project);
      closeCreateProjectModal();
      await switchProject(project.id);
    } catch (err) {
      showToast("Failed to create project: " + err.message, "error");
    }
  }
  var _deleteProjectId = null;
  async function deleteProjectConfirm(id, name) {
    _deleteProjectId = id;
    const confirmed = await showConfirmDelete(name, "Delete workspace?");
    if (!confirmed) {
      _deleteProjectId = null;
      return;
    }
    try {
      await api.deleteProject(id);
      state.projects = state.projects.filter((p) => p.id !== id);
      if (getCurrentProjectId() === id) {
        await switchProject("default");
      } else {
        renderProjectSwitcher();
      }
      showToast(`"${name}" deleted`);
    } catch (err) {
      showToast(err.message, "error");
    }
    _deleteProjectId = null;
  }
  function closeConfirmDeleteProject(result) {
    closeConfirmDelete(result);
  }
  var _renameProjectId = null;
  function openRenameProjectModal(id, currentName) {
    _renameProjectId = id;
    document.getElementById("project-menu")?.classList.remove("open");
    const overlay = document.getElementById("rename-project-overlay");
    if (overlay) overlay.classList.add("open");
    const input = document.getElementById("rename-project-input");
    if (input) {
      input.value = currentName;
      input.focus();
      input.select();
    }
  }
  function closeRenameProjectModal() {
    document.getElementById("rename-project-overlay")?.classList.remove("open");
    _renameProjectId = null;
  }
  async function submitRenameProject() {
    const input = document.getElementById("rename-project-input");
    const name = input?.value.trim();
    if (!name || !_renameProjectId) return;
    try {
      const { project } = await api.renameProject(_renameProjectId, name);
      const idx = state.projects.findIndex((p) => p.id === project.id);
      if (idx !== -1) state.projects[idx] = project;
      renderProjectSwitcher();
      closeRenameProjectModal();
      showToast(`Renamed to "${name}"`);
    } catch (err) {
      showToast(err.message, "error");
    }
  }
  async function loadSettings() {
    try {
      const { settings } = await api.getSettings();
      state.settings = settings;
      state.theme = settings.theme || "dark";
    } catch {
    }
  }
  async function applyAIVisibility() {
    try {
      const { profiles } = await api.getProfiles();
      state.aiEnabled = profiles.length > 0;
    } catch {
      state.aiEnabled = false;
    }
    const show = state.aiEnabled;
    const chatToggle = document.getElementById("chat-toggle");
    if (chatToggle) chatToggle.style.display = show ? "" : "none";
    if (!show && state.chatOpen) {
      state.chatOpen = false;
      document.getElementById("chat-drawer")?.classList.remove("open");
    }
  }
  function applyTheme(theme) {
    state.theme = theme;
    document.documentElement.setAttribute("data-theme", theme);
    const themeIcon = $("theme-icon");
    if (themeIcon) themeIcon.textContent = theme === "dark" ? "\u2600\uFE0F" : "\u{1F319}";
  }
  function toggleTheme() {
    const next = state.theme === "dark" ? "light" : "dark";
    applyTheme(next);
    api.saveSettings({ theme: next });
  }
  async function loadPages() {
    try {
      const { pages } = await api.getFlat();
      state.pages = pages;
      renderSidebar();
    } catch (err) {
      showToast("Failed to load pages: " + err.message, "error");
    }
  }
  function renderSidebar() {
    const nav = $("sidebar-nav");
    const searchEl = $("sidebar-search");
    const searchVal = (searchEl?.value || "").toLowerCase().trim();
    const map = {};
    state.pages.forEach((p) => {
      map[p.id] = { ...p, _children: [] };
    });
    const roots = [];
    state.pages.forEach((p) => {
      if (p.parent_id && map[p.parent_id]) {
        map[p.parent_id]._children.push(map[p.id]);
      } else if (!p.parent_id) {
        roots.push(map[p.id]);
      }
    });
    nav.innerHTML = "";
    const label = document.createElement("div");
    label.className = "nav-label";
    label.textContent = "pages";
    nav.appendChild(label);
    if (searchVal) {
      const matched = state.pages.filter((p) => {
        const name = (p.display_name || p.name || "").toLowerCase();
        return name.includes(searchVal);
      });
      if (!matched.length) {
        nav.innerHTML += `<div style="text-align:center;padding:20px 0;color:var(--text-dim);font-size:13px;">No results found</div>`;
      } else {
        matched.forEach((p) => nav.appendChild(buildNavItem(map[p.id], false)));
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
    const isFolder = page.type === "folder";
    const hasChildren = page._children && page._children.length > 0;
    const isExpanded = state.expandedFolders.has(page.id);
    const displayName = page.display_name || page.name;
    const numStr = page.num || (num ? String(num).padStart(2, "0") : null);
    if (isFolder) {
      const wrapper = document.createElement("div");
      const item = document.createElement("div");
      item.className = "nav-item";
      item.dataset.pageId = page.id;
      item.innerHTML = `
      <div class="nav-item-inner">
        ${numStr ? `<span class="nav-num">${numStr}</span>` : ""}
        <svg class="nav-icon" viewBox="0 0 20 20" fill="currentColor">
          <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
        </svg>
        <span class="nav-name">${esc(displayName)}</span>

      </div>
      ${hasChildren ? `
        <button class="nav-expand-btn${isExpanded ? " open" : ""}" data-folder-id="${page.id}">
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>
        </button>
      ` : ""}
    `;
      item.addEventListener("click", (e) => {
        const isExpandBtn = e.target.closest(".nav-expand-btn");
        if (isExpandBtn) {
          toggleFolder(page.id);
        } else {
          navigateTo(page.id);
        }
      });
      item.addEventListener("contextmenu", (e) => showCtxMenu(e, page));
      wrapper.appendChild(item);
      if (hasChildren) {
        const childrenEl = document.createElement("div");
        childrenEl.className = `nav-children${isExpanded ? " open" : ""}`;
        childrenEl.id = `children-${page.id}`;
        page._children.forEach((child) => childrenEl.appendChild(buildSubNavItem(child)));
        wrapper.appendChild(childrenEl);
      }
      return wrapper;
    } else {
      const item = document.createElement("div");
      item.className = "nav-item";
      item.dataset.pageId = page.id;
      const ext = page.file_type || "md";
      const icon = ext === "html" ? `<svg class="nav-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.083 9h1.946c.089-1.546.383-2.97.837-4.118A6.004 6.004 0 004.083 9zM10 2a8 8 0 100 16A8 8 0 0010 2zm0 2c-.076 0-.232.032-.465.262-.238.234-.497.623-.737 1.182-.389.907-.673 2.142-.766 3.556h3.936c-.093-1.414-.377-2.649-.766-3.556-.24-.56-.5-.948-.737-1.182C10.232 4.032 10.076 4 10 4zm3.971 5c-.089-1.546-.383-2.97-.837-4.118A6.004 6.004 0 0115.917 9h-1.946zm-2.003 2H8.032c.093 1.414.377 2.649.766 3.556.24.56.5.948.737 1.182.233.23.389.262.465.262.076 0 .232-.032.465-.262.238-.234.498-.623.737-1.182.389-.907.673-2.142.766-3.556zm1.166 4.118c.454-1.147.748-2.572.837-4.118h1.946a6.004 6.004 0 01-2.783 4.118zm-6.268 0C6.412 13.97 6.118 12.546 6.03 11H4.083a6.004 6.004 0 002.783 4.118z" clip-rule="evenodd"/></svg>` : `<svg class="nav-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"/></svg>`;
      item.innerHTML = `
      <div class="nav-item-inner">
        ${numStr ? `<span class="nav-num">${numStr}</span>` : ""}
        ${icon}
        <span class="nav-name">${esc(displayName)}</span>
        <span class="nav-count">${ext}</span>
      </div>
    `;
      item.addEventListener("click", () => navigateTo(page.id));
      item.addEventListener("contextmenu", (e) => showCtxMenu(e, page));
      return item;
    }
  }
  function buildSubNavItem(page) {
    const displayName = page.display_name || page.name;
    const isFolder = page.type === "folder";
    const item = document.createElement("div");
    item.className = "nav-sub-item";
    item.dataset.pageId = page.id;
    const icon = isFolder ? `<svg class="nav-sub-icon" viewBox="0 0 20 20" fill="currentColor"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>` : `<svg class="nav-sub-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z" clip-rule="evenodd"/></svg>`;
    item.innerHTML = `${icon}<span class="nav-sub-name">${esc(displayName)}</span>`;
    item.addEventListener("click", () => navigateTo(page.id));
    item.addEventListener("contextmenu", (e) => showCtxMenu(e, page));
    return item;
  }
  function toggleFolder(folderId) {
    const childrenEl = $(`children-${folderId}`);
    const btn = document.querySelector(`[data-folder-id="${folderId}"]`);
    if (state.expandedFolders.has(folderId)) {
      state.expandedFolders.delete(folderId);
      childrenEl?.classList.remove("open");
      btn?.classList.remove("open");
    } else {
      state.expandedFolders.add(folderId);
      childrenEl?.classList.add("open");
      btn?.classList.add("open");
    }
  }
  function highlightActive() {
    $$("[data-page-id]").forEach((el) => {
      const isActive = el.dataset.pageId === state.currentPageId;
      el.classList.toggle("active", isActive);
    });
  }
  async function navigateTo(pageId) {
    if (pageId === state.currentPageId) return;
    if (state.wysiwyg) {
      clearTimeout(saveTimer);
      state.wysiwyg = null;
    }
    state.currentPageId = pageId;
    window.location.hash = `page/${pageId}`;
    const page = state.pages.find((p) => p.id === pageId);
    if (page?.parent_id) {
      state.expandedFolders.add(page.parent_id);
    }
    if (page?.type === "folder") {
      state.expandedFolders.add(pageId);
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
  async function renderPage(pageId) {
    const content = $("content-area");
    content.className = "content-area";
    content.innerHTML = `<div class="fade-in" style="text-align:center;padding:60px 0;color:var(--text-dim);"><div>Loading\u2026</div></div>`;
    hideSaveState();
    try {
      const { page } = await api.getPage(pageId);
      state.currentPage = page;
      updateTopbar(page);
      const isPage = page.type === "page";
      const isMd = page.file_type === "md";
      const isHtml = isPage && page.file_type === "html";
      $("html-edit-btn").classList.toggle("hidden", !isHtml);
      if (isHtml) {
        $("html-edit-btn").textContent = "\u270F\uFE0F Edit HTML";
      }
      if (page.type === "folder") {
        renderFolderView(page, content);
      } else if (page.file_type === "md") {
        renderWysiwygEditor(page, content);
      } else if (page.file_type === "html") {
        renderHtmlEditor(page, content);
      }
    } catch (err) {
      content.innerHTML = `<div class="fade-in" style="text-align:center;padding:60px 0;color:var(--danger);">Failed to load: ${esc(err.message)}</div>`;
    }
  }
  function updateTopbar(page) {
    const parent = state.pages.find((p) => p.id === page.parent_id);
    $("bc-parent").textContent = parent ? parent.display_name || parent.name : "yo\u0131nko";
    $("page-title").value = page.display_name || page.name;
    $("topbar-badge").textContent = page.type === "folder" ? "folder" : page.file_type || "md";
  }
  function toggleEditMode() {
  }
  function tiptapToMarkdown(doc) {
    function inline(nodes) {
      if (!nodes) return "";
      return nodes.map((n) => {
        if (n.type === "hardBreak") return "  \n";
        let t = n.text || "";
        if (n.marks) {
          if (n.marks.some((m) => m.type === "code")) return `\`${t}\``;
          n.marks.forEach((m) => {
            if (m.type === "bold") t = `**${t}**`;
            else if (m.type === "italic") t = `*${t}*`;
            else if (m.type === "strike") t = `~~${t}~~`;
            else if (m.type === "underline") t = `<u>${t}</u>`;
            else if (m.type === "link") t = `[${t}](${m.attrs?.href || ""})`;
          });
        }
        return t;
      }).join("");
    }
    function serializeListItem(node, prefix) {
      const c = node.content || [];
      if (c.length === 0) return prefix + "\n";
      const first = c[0];
      const textLine = first.type === "paragraph" ? inline(first.content).trimEnd() : blk(first).trimEnd();
      const nested = c.slice(1).map((n) => blk(n).replace(/^(?=.)/gm, "    ")).join("");
      return prefix + textLine + "\n" + nested;
    }
    function blk(node) {
      const t = node.type;
      const c = node.content || [];
      if (t === "doc") return c.map((n) => blk(n)).join("\n");
      if (t === "paragraph") return inline(c) + "\n";
      if (t === "heading") return "#".repeat(node.attrs?.level || 1) + " " + inline(c) + "\n";
      if (t === "horizontalRule") return "---\n";
      if (t === "codeBlock") {
        const lang = node.attrs?.language || "";
        const code = c.map((n) => n.text || "").join("");
        return `\`\`\`${lang}
${code}
\`\`\`
`;
      }
      if (t === "blockquote") {
        return c.map((n) => blk(n).replace(/^/gm, "> ").replace(/> $/gm, ">").trimEnd()).join("\n") + "\n";
      }
      if (t === "bulletList") return c.map((n) => serializeListItem(n, "- ")).join("");
      if (t === "orderedList") {
        let i = node.attrs?.start || 1;
        return c.map((n) => serializeListItem(n, `${i++}. `)).join("");
      }
      if (t === "taskList") {
        return c.map((n) => {
          const checked = n.attrs?.checked;
          const checkbox = checked ? "[x]" : "[ ]";
          const children = n.content || [];
          const first = children[0];
          const textPart = first ? first.type === "paragraph" ? inline(first.content).trimEnd() : blk(first).trimEnd() : "";
          const nested = children.slice(1).map((n2) => blk(n2).replace(/^(?=.)/gm, "    ")).join("");
          return `- ${checkbox} ${textPart}
${nested}`;
        }).join("");
      }
      if (t === "hardBreak") return "  \n";
      if (t === "text") return node.text || "";
      if (t === "table") {
        const rows = c.map((row, rowIdx) => {
          const cells = (row.content || []).map((cell) => {
            return (cell.content || []).map((n) => blk(n)).join("").replace(/\n/g, " ").trim();
          });
          const rowStr = "| " + cells.join(" | ") + " |";
          if (rowIdx === 0) {
            const sep = "| " + cells.map(() => "----------").join(" | ") + " |";
            return rowStr + "\n" + sep;
          }
          return rowStr;
        });
        return rows.join("\n") + "\n";
      }
      return c.map((n) => blk(n)).join("");
    }
    try {
      return blk(doc).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    } catch {
      return "";
    }
  }
  function renderWysiwygEditor(page, container) {
    container.className = "content-area wysiwyg-wrap fade-in";
    container.innerHTML = `
    <div class="wysiwyg-page">
      <div class="editor-toolbar" id="editor-toolbar" role="toolbar" aria-label="Formatting">

        <!-- History -->
        <button class="tb-btn" id="tb-undo" title="Undo (\u2318Z)">
          <i data-lucide="undo-2"></i>
        </button>
        <button class="tb-btn" id="tb-redo" title="Redo (\u2318\u21E7Z)">
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
            <button class="tb-menu-item" data-level="0"><span class="tb-menu-badge">\xB6</span>Normal</button>
          </div>
        </div>

        <span class="tb-sep"></span>

        <!-- Inline marks -->
        <button class="tb-btn" id="tb-bold" title="Bold (\u2318B)">
          <i data-lucide="bold"></i>
        </button>
        <button class="tb-btn" id="tb-italic" title="Italic (\u2318I)">
          <i data-lucide="italic"></i>
        </button>
        <button class="tb-btn" id="tb-underline" title="Underline (\u2318U)">
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
          <button class="tb-btn" id="tb-link" title="Link (\u2318K)">
            <i data-lucide="link"></i>
          </button>
          <div class="tb-dropdown-menu tb-link-menu" id="tb-link-menu">
            <!-- Tabs -->
            <div class="tb-link-tabs">
              <button class="tb-link-tab active" id="tb-tab-url" data-tab="url">URL</button>
              <button class="tb-link-tab" id="tb-tab-page" data-tab="page">Page</button>
            </div>

            <!-- URL panel -->
            <div class="tb-link-panel" id="tb-panel-url">
              <input class="tb-link-input" id="tb-link-input" type="url" placeholder="https://\u2026" autocomplete="off" spellcheck="false" />
              <div class="tb-link-actions">
                <button class="tb-link-ok" id="tb-link-ok">Apply</button>
                <button class="tb-link-remove" id="tb-link-remove">Remove</button>
              </div>
            </div>

            <!-- Page picker panel -->
            <div class="tb-link-panel hidden" id="tb-panel-page">
              <input class="tb-link-input" id="tb-page-search" type="text" placeholder="Search pages\u2026" autocomplete="off" spellcheck="false" />
              <div class="tb-page-list" id="tb-page-list"></div>
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
      </div>
            ${renderAssetsSection(page)}
      ${renderUploadZone(page.id)}
    </div>
  `;
    setupUploadZone(page.id);
    if (state.wysiwyg) {
      try {
        state.wysiwyg.destroy();
      } catch {
      }
      state.wysiwyg = null;
    }
    if (!window.TipTapBundle) {
      showToast("Editor bundle not loaded \u2014 please refresh", "error");
      console.error("TipTapBundle not found on window");
      return;
    }
    const { Editor, Extension, InputRule, StarterKit, TaskList, TaskItem, Placeholder, Table, TableRow, TableCell, TableHeader, Underline, Link, ListKeymap } = window.TipTapBundle;
    const TaskBracketRule = Extension.create({
      name: "taskBracketRule",
      addInputRules() {
        return [
          new InputRule({
            find: /^\[\s*[xX]?\s*\]\s$/,
            handler: ({ chain, range }) => {
              chain().deleteRange(range).clearNodes().toggleTaskList().run();
            }
          })
        ];
      }
    });
    const initialHtml = page.content ? renderMarkdown(page.content) : "";
    const editor = new Editor({
      element: $("wysiwyg-editor"),
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5, 6] }
        }),
        TaskList,
        TaskItem.configure({ nested: true }),
        TaskBracketRule,
        Table.configure({ resizable: false }),
        TableRow,
        TableCell,
        TableHeader,
        Underline,
        Link.configure({
          openOnClick: false,
          validate: () => true,
          HTMLAttributes: { rel: "noopener noreferrer" }
        }),
        ListKeymap,
        Placeholder.configure({
          placeholder: "Start writing\u2026 Use # for headings, [] for tasks, - for lists"
        })
      ],
      content: initialHtml,
      autofocus: true,
      editorProps: {
        attributes: { class: "tiptap-content", spellcheck: "true" },
        // Copy/cut → write markdown to the clipboard's text/plain MIME type so
        // pasting outside the editor (chat, terminal, another app) lands as
        // proper Markdown instead of unstyled plain text. text/html still
        // carries the rich representation, so paste-back into TipTap (or
        // another rich editor) keeps full formatting.
        clipboardTextSerializer: (slice) => {
          const json = slice.content.toJSON();
          if (!json || !json.length) return "";
          const allInline = json.every(
            (n) => n.type === "text" || n.type === "hardBreak"
          );
          const content = allInline ? [{ type: "paragraph", content: json }] : json;
          return tiptapToMarkdown({ type: "doc", content }).replace(/\n+$/, "");
        }
      },
      onUpdate({ editor: editor2 }) {
        const md = tiptapToMarkdown(editor2.getJSON());
        debounceSave(md);
        if (state.currentPage) state.currentPage.content = md;
      }
    });
    state.wysiwyg = editor;
    buildEditorToolbar(editor);
    $("wysiwyg-editor").addEventListener("keydown", (e) => {
      const ke = e;
      if ((ke.metaKey || ke.ctrlKey) && ke.key === "s") {
        ke.preventDefault();
        savePage(tiptapToMarkdown(editor.getJSON()));
      }
    }, true);
  }
  function buildEditorToolbar(editor) {
    const toolbar = document.getElementById("editor-toolbar");
    if (!toolbar) return;
    const lucide = window.lucide;
    if (lucide?.createIcons) {
      lucide.createIcons({
        nameAttr: "data-lucide",
        attrs: { "stroke-width": "1.8" }
      });
    }
    const marks = ["bold", "italic", "underline", "strike", "code"];
    const blocks = ["bulletList", "orderedList", "taskList", "blockquote", "codeBlock"];
    function refreshActive() {
      marks.forEach((m) => {
        document.getElementById(`tb-${m}`)?.classList.toggle("active", editor.isActive(m));
      });
      blocks.forEach((b) => {
        const id = b === "bulletList" ? "tb-bullet" : b === "orderedList" ? "tb-ordered" : b === "taskList" ? "tb-task" : b === "blockquote" ? "tb-blockquote" : "tb-codeblock";
        document.getElementById(id)?.classList.toggle("active", editor.isActive(b));
      });
      const hBtn = document.getElementById("tb-heading");
      const hLabel = document.getElementById("tb-heading-label");
      if (hBtn && hLabel) {
        const activeLevel = [1, 2, 3, 4].find((l) => editor.isActive("heading", { level: l }));
        hBtn.classList.toggle("active", !!activeLevel);
        hLabel.textContent = activeLevel ? `H${activeLevel}` : "Text";
      }
      document.getElementById("tb-link")?.classList.toggle("active", editor.isActive("link"));
    }
    editor.on("transaction", refreshActive);
    refreshActive();
    function btn(id, action) {
      document.getElementById(id)?.addEventListener("mousedown", (e) => {
        e.preventDefault();
        action();
      });
    }
    btn("tb-undo", () => editor.chain().focus().undo().run());
    btn("tb-redo", () => editor.chain().focus().redo().run());
    btn("tb-bold", () => editor.chain().focus().toggleBold().run());
    btn("tb-italic", () => editor.chain().focus().toggleItalic().run());
    btn("tb-underline", () => editor.chain().focus().toggleUnderline().run());
    btn("tb-strike", () => editor.chain().focus().toggleStrike().run());
    btn("tb-code", () => editor.chain().focus().toggleCode().run());
    btn("tb-bullet", () => editor.chain().focus().toggleBulletList().run());
    btn("tb-ordered", () => editor.chain().focus().toggleOrderedList().run());
    btn("tb-task", () => editor.chain().focus().toggleTaskList().run());
    btn("tb-blockquote", () => editor.chain().focus().toggleBlockquote().run());
    btn("tb-codeblock", () => editor.chain().focus().toggleCodeBlock().run());
    btn("tb-hr", () => editor.chain().focus().setHorizontalRule().run());
    const headingWrap = document.getElementById("tb-heading-wrap");
    const headingMenu = document.getElementById("tb-heading-menu");
    const headingBtn = document.getElementById("tb-heading");
    headingBtn?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      headingMenu?.classList.toggle("open");
      linkMenu?.classList.remove("open");
    });
    headingMenu?.querySelectorAll("[data-level]").forEach((item) => {
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const level = parseInt(item.dataset.level || "0");
        if (level === 0) {
          editor.chain().focus().setParagraph().run();
        } else {
          editor.chain().focus().toggleHeading({ level }).run();
        }
        headingMenu.classList.remove("open");
      });
    });
    const linkWrap = document.getElementById("tb-link-wrap");
    const linkMenu = document.getElementById("tb-link-menu");
    const linkBtn = document.getElementById("tb-link");
    const linkInput = document.getElementById("tb-link-input");
    const linkOk = document.getElementById("tb-link-ok");
    const linkRemove = document.getElementById("tb-link-remove");
    const tabUrl = document.getElementById("tb-tab-url");
    const tabPage = document.getElementById("tb-tab-page");
    const panelUrl = document.getElementById("tb-panel-url");
    const panelPage = document.getElementById("tb-panel-page");
    const pageSearch = document.getElementById("tb-page-search");
    const pageList = document.getElementById("tb-page-list");
    function switchTab(tab) {
      tabUrl?.classList.toggle("active", tab === "url");
      tabPage?.classList.toggle("active", tab === "page");
      panelUrl?.classList.toggle("hidden", tab !== "url");
      panelPage?.classList.toggle("hidden", tab !== "page");
      if (tab === "url") {
        setTimeout(() => linkInput?.focus(), 10);
      } else {
        populatePageList("");
        setTimeout(() => pageSearch?.focus(), 10);
      }
    }
    tabUrl?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      switchTab("url");
    });
    tabPage?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      switchTab("page");
    });
    function populatePageList(query) {
      if (!pageList) return;
      const q = query.toLowerCase().trim();
      pageList.innerHTML = "";
      function makeItem(p, depth) {
        const item = document.createElement("button");
        item.className = "tb-page-item";
        item.type = "button";
        item.dataset.type = p.type;
        if (depth > 0) {
          const indent = document.createElement("span");
          indent.className = "tb-page-indent";
          indent.style.width = `${depth * 14}px`;
          indent.style.flexShrink = "0";
          item.appendChild(indent);
        }
        const icon = document.createElement("i");
        icon.setAttribute("data-lucide", p.type === "folder" ? "folder" : "file-text");
        item.appendChild(icon);
        const labelWrap = document.createElement("span");
        labelWrap.className = "tb-page-item-label";
        const nameEl = document.createElement("span");
        nameEl.className = "tb-page-item-name";
        nameEl.textContent = p.display_name || p.name;
        labelWrap.appendChild(nameEl);
        const pathEl = document.createElement("span");
        pathEl.className = "tb-page-item-path";
        pathEl.textContent = p.name;
        labelWrap.appendChild(pathEl);
        item.appendChild(labelWrap);
        item.addEventListener("mousedown", (e) => {
          e.preventDefault();
          editor.chain().focus().setLink({ href: `#page/${p.id}`, target: "_self" }).run();
          linkMenu?.classList.remove("open");
        });
        return item;
      }
      if (q) {
        const matches = state.pages.filter(
          (p) => p.display_name.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
        );
        if (matches.length === 0) {
          pageList.innerHTML = '<div class="tb-page-empty">No results found</div>';
          return;
        }
        matches.forEach((p) => pageList.appendChild(makeItem(p, 0)));
      } else {
        let traverse2 = function(parentId, depth) {
          const children = childMap.get(parentId) || [];
          children.forEach((p) => {
            pageList.appendChild(makeItem(p, depth));
            traverse2(p.id, depth + 1);
          });
        };
        var traverse = traverse2;
        const childMap = /* @__PURE__ */ new Map();
        state.pages.forEach((p) => {
          const key = p.parent_id || "";
          if (!childMap.has(key)) childMap.set(key, []);
          childMap.get(key).push(p);
        });
        childMap.forEach((children) => {
          children.sort((a, b) => {
            if (a.type === b.type) return (a.display_name || a.name).localeCompare(b.display_name || b.name);
            return a.type === "folder" ? -1 : 1;
          });
        });
        if ((childMap.get("") || []).length === 0) {
          pageList.innerHTML = '<div class="tb-page-empty">No pages yet</div>';
          return;
        }
        traverse2("", 0);
      }
      const lucide2 = window.lucide;
      lucide2?.createIcons?.({ nameAttr: "data-lucide", attrs: { "stroke-width": "1.8" } });
    }
    pageSearch?.addEventListener("input", () => populatePageList(pageSearch.value));
    pageSearch?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") linkMenu?.classList.remove("open");
      if (e.key === "Enter") {
        const first = pageList?.querySelector(".tb-page-item");
        first?.click();
      }
    });
    linkBtn?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const wasOpen = linkMenu?.classList.contains("open");
      linkMenu?.classList.toggle("open");
      headingMenu?.classList.remove("open");
      if (!wasOpen && linkMenu?.classList.contains("open")) {
        const attrs = editor.isActive("link") ? editor.getAttributes("link") : {};
        const existingHref = attrs.href || "";
        if (linkInput) linkInput.value = existingHref;
        switchTab("url");
      }
    });
    linkOk?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const url = linkInput?.value.trim() || "";
      if (url) editor.chain().focus().setLink({ href: url, target: "_blank" }).run();
      linkMenu?.classList.remove("open");
    });
    linkInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const url = linkInput.value.trim();
        if (url) editor.chain().focus().setLink({ href: url, target: "_blank" }).run();
        linkMenu?.classList.remove("open");
      }
      if (e.key === "Escape") linkMenu?.classList.remove("open");
    });
    linkRemove?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      editor.chain().focus().unsetLink().run();
      linkMenu?.classList.remove("open");
    });
    document.addEventListener("mousedown", (e) => {
      if (!headingWrap?.contains(e.target)) headingMenu?.classList.remove("open");
      if (!linkWrap?.contains(e.target)) linkMenu?.classList.remove("open");
    }, { capture: true });
  }
  function renderHtmlEditor(page, container) {
    container.className = "content-area fade-in";
    container.innerHTML = `
    <iframe class="html-preview-frame" id="html-preview-frame" style="width:100%;height:100%;border:none;display:block"></iframe>
  `;
    const frame = $("html-preview-frame");
    frame.srcdoc = page.content || "<p>Empty page</p>";
  }
  function toggleHtmlEditMode() {
    const container = $("content-area");
    const page = state.currentPage;
    if (!page) return;
    const isEditing = container.classList.contains("editor-mode");
    if (isEditing) {
      container.className = "content-area fade-in";
      container.innerHTML = `
      <iframe class="html-preview-frame" id="html-preview-frame" style="width:100%;height:100%;border:none;display:block"></iframe>
    `;
      $("html-preview-frame").srcdoc = page.content || "<p>Empty page</p>";
      $("html-edit-btn").textContent = "\u270F\uFE0F Edit HTML";
    } else {
      container.className = "content-area editor-mode fade-in";
      container.innerHTML = `
      <div class="editor-pane html-editor-wrap" style="flex:1">
        <div class="editor-pane-label">\u270F\uFE0F html source</div>
        <textarea class="editor-textarea" id="editor-textarea" placeholder="Write HTML\u2026" spellcheck="false" style="flex:1">${esc(page.content || "")}</textarea>
      </div>
      <div class="editor-pane html-editor-wrap" style="flex:1;border-right:none">
        <div class="editor-pane-label">\u{1F441} live preview</div>
        <iframe class="html-preview-frame" id="html-preview-frame"></iframe>
      </div>
    `;
      const textarea = $("editor-textarea");
      const frame = $("html-preview-frame");
      const updateFrame = () => {
        frame.srcdoc = textarea.value || "<p>Empty page</p>";
      };
      textarea.addEventListener("input", () => {
        updateFrame();
        debounceSave(textarea.value);
        if (page) page.content = textarea.value;
      });
      textarea.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "s") {
          e.preventDefault();
          savePage(textarea.value);
        }
        if (e.key === "Tab") {
          e.preventDefault();
          const s = textarea.selectionStart;
          textarea.value = textarea.value.slice(0, s) + "  " + textarea.value.slice(textarea.selectionEnd);
          textarea.selectionStart = textarea.selectionEnd = s + 2;
          debounceSave(textarea.value);
        }
      });
      updateFrame();
      requestAnimationFrame(() => textarea.focus());
      $("html-edit-btn").textContent = "\u{1F441} Preview";
    }
  }
  var saveTimer;
  function debounceSave(content) {
    clearTimeout(saveTimer);
    showSavingState();
    saveTimer = setTimeout(() => savePage(content), 1e3);
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
      showToast("Save failed: " + err.message, "error");
      hideSaveState();
    }
  }
  function showSavingState() {
    $("saving-indicator")?.classList.remove("hidden");
    $("save-indicator")?.classList.add("hidden");
  }
  function showSavedState() {
    $("saving-indicator")?.classList.add("hidden");
    const saved = $("save-indicator");
    saved?.classList.remove("hidden");
    setTimeout(() => saved?.classList.add("hidden"), 2500);
  }
  function hideSaveState() {
    $("saving-indicator")?.classList.add("hidden");
    $("save-indicator")?.classList.add("hidden");
  }
  function renderFolderView(page, container) {
    container.className = "content-area fade-in";
    const children = page.children || [];
    const allPages = state.pages;
    const roots = allPages.filter((p) => !p.parent_id);
    const rootIdx = roots.findIndex((p) => p.id === page.id);
    const sectionNum = rootIdx >= 0 ? String(rootIdx + 1).padStart(2, "0") : page.num || "\u2014";
    const displayName = page.display_name || page.name;
    container.innerHTML = `
    <div class="folder-index">
      <div class="folder-header">
        <div class="folder-title-group">
          ${rootIdx >= 0 ? `<div class="folder-num">SECTION ${sectionNum}</div>` : ""}
          <h1 class="folder-title" style="margin:0">${esc(displayName)}</h1>
          <p class="folder-meta">${children.length + (page.assets?.length || 0)} item${children.length + (page.assets?.length || 0) !== 1 ? "s" : ""}</p>
        </div>
        <div class="folder-actions">
          <button class="btn btn-sm btn-ghost" onclick="openNewPageModal('page','${page.id}')">\u{1F4DD} Add Page</button>
          <button class="btn btn-sm btn-ghost" onclick="openNewPageModal('folder','${page.id}')">\u{1F4C1} Add Folder</button>
          <button class="btn btn-sm btn-ghost" onclick="openNewPageModal('image')">\u{1F5BC}\uFE0F Add Image</button>
        </div>
      </div>

      <div class="section-heading">Contents</div>
      ${children.length ? `
        <div class="children-grid">
          ${children.map((child) => {
      const childName = child.display_name || child.name;
      const ext = child.file_type || "";
      return `
              <div class="child-card" onclick="navigateTo('${child.id}')">
                <div class="child-card-icon ${child.type === "folder" ? "folder" : ext}">
                  ${child.type === "folder" ? "\u{1F4C1}" : ext === "html" ? "\u{1F310}" : "\u{1F4DD}"}
                </div>
                <div class="child-card-name">${esc(childName)}</div>
                <div class="child-card-meta">${child.type === "folder" ? `${state.pages.filter((p) => p.parent_id === child.id).length + (child.asset_count || 0)} items` : ext.toUpperCase() || "MD"}</div>
                <button class="child-card-menu-btn" onclick="openChildCardMenu('${child.id}', event)" title="Actions" aria-label="Actions">\u22EF</button>
              </div>
            `;
    }).join("")}
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
  function renderAssetsSection(page) {
    const assets = page.assets || [];
    if (!assets.length) return "";
    const imgs = assets.filter((a) => a.mime_type?.startsWith("image/"));
    const files = assets.filter((a) => !a.mime_type?.startsWith("image/"));
    return `
    <div class="assets-section">
      ${imgs.length ? `
        <div class="section-heading">Images &amp; Media \xB7 ${imgs.length}</div>
        <div class="asset-grid">
          ${imgs.map((a) => `
            <div class="asset-card" onclick="openLightbox('${api.assetUrl(a.id)}','${esc(a.original_name)}')">
              <div class="asset-preview">
                <img src="${api.assetUrl(a.id)}" alt="${esc(a.original_name)}" loading="lazy">
              </div>
              <div class="asset-info">
                <div class="asset-name">${esc(a.original_name)}</div>
                <div class="asset-type">${(a.size / 1024).toFixed(1)} KB</div>
              </div>
              <button class="asset-menu-btn" onclick="openAssetCardMenu('${a.id}', event)" title="Actions" aria-label="Actions">\u22EF</button>
            </div>
          `).join("")}
        </div>
      ` : ""}
      ${files.length ? `
        <div class="section-heading" style="margin-top:${imgs.length ? "24px" : 0}">Files \xB7 ${files.length}</div>
        <div class="file-asset-grid">
          ${files.map((a) => {
      const ext = (a.original_name.split(".").pop() || "").toUpperCase().slice(0, 4);
      const sizeKb = a.size / 1024;
      const sizeLabel = sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb.toFixed(1)} KB`;
      return `
            <div class="file-asset-card" data-ext="${ext.toLowerCase()}" onclick="window.open('${api.assetUrl(a.id)}','_blank')">
              <div class="file-asset-icon"><span class="file-asset-ext">${ext || "FILE"}</span></div>
              <div class="file-asset-info">
                <div class="file-asset-name">${esc(a.original_name)}</div>
                <div class="file-asset-meta">${sizeLabel}</div>
              </div>
              <button class="asset-menu-btn asset-menu-btn--inline" onclick="openAssetCardMenu('${a.id}', event)" title="Actions" aria-label="Actions">\u22EF</button>
            </div>
          `;
    }).join("")}
        </div>
      ` : ""}
    </div>
  `;
  }
  var SVG_ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  var ICON = {
    externalLink: `<svg ${SVG_ATTRS}><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>`,
    download: `<svg ${SVG_ATTRS}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>`,
    copy: `<svg ${SVG_ATTRS}><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`,
    trash: `<svg ${SVG_ATTRS}><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/></svg>`,
    pencil: `<svg ${SVG_ATTRS}><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>`,
    arrowRight: `<svg ${SVG_ATTRS}><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>`,
    folderMove: `<svg ${SVG_ATTRS}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="9" y1="14" x2="15" y2="14"/><polyline points="12 11 15 14 12 17"/></svg>`,
    plus: `<svg ${SVG_ATTRS}><line x1="12" x2="12" y1="5" y2="19"/><line x1="5" x2="19" y1="12" y2="12"/></svg>`,
    fileText: `<svg ${SVG_ATTRS}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
    folder: `<svg ${SVG_ATTRS}><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
    chevronRight: `<svg ${SVG_ATTRS}><polyline points="9 18 15 12 9 6"/></svg>`,
    chevronDown: `<svg ${SVG_ATTRS}><polyline points="6 9 12 15 18 9"/></svg>`
  };
  var _activeMenuTrigger = null;
  var _hoverSubmenuTimer = null;
  function renderMenuItems(items) {
    return items.map((it, i) => {
      const cls = `floating-card-menu-item${it.danger ? " danger" : ""}${it.submenu ? " has-submenu" : ""}`;
      const icon = `<span class="floating-card-menu-icon" aria-hidden="true">${it.icon || ""}</span>`;
      const label = `<span class="floating-card-menu-label">${esc(it.label)}</span>`;
      const arrow = it.submenu ? `<span class="floating-card-menu-chevron" aria-hidden="true">${ICON.chevronRight}</span>` : "";
      if (it.href) {
        const tgt = it.target ? ` target="${it.target}" rel="noopener"` : "";
        const dl = it.download ? ` download="${esc(it.download)}"` : "";
        return `<a class="${cls}" href="${it.href}"${tgt}${dl} data-idx="${i}">${icon}${label}${arrow}</a>`;
      }
      return `<button class="${cls}" data-idx="${i}" type="button">${icon}${label}${arrow}</button>`;
    }).join("");
  }
  function positionFloatingMenu(menu, anchor, opts = {}) {
    const margin = 8;
    const gap = 6;
    const menuRect = menu.getBoundingClientRect();
    let left;
    let top;
    if (anchor instanceof HTMLElement) {
      const r = anchor.getBoundingClientRect();
      if (opts.preferRight) {
        left = r.right + 4;
        if (left + menuRect.width > window.innerWidth - margin) {
          left = r.left - menuRect.width - 4;
        }
        top = r.top;
        if (top + menuRect.height > window.innerHeight - margin) {
          top = window.innerHeight - menuRect.height - margin;
        }
      } else {
        left = r.left;
        top = r.bottom + gap;
        if (top + menuRect.height > window.innerHeight - margin) {
          const aboveTop = r.top - menuRect.height - gap;
          if (aboveTop >= margin) top = aboveTop;
        }
      }
    } else {
      left = anchor.x;
      top = anchor.y;
      if (top + menuRect.height > window.innerHeight - margin) {
        top = window.innerHeight - menuRect.height - margin;
      }
    }
    if (left + menuRect.width > window.innerWidth - margin) {
      left = window.innerWidth - menuRect.width - margin;
    }
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }
  function attachItemHandlers(menu, items, isSubmenu) {
    menu.querySelectorAll("[data-idx]").forEach((el) => {
      const idx = Number(el.dataset.idx);
      const item = items[idx];
      if (!item) return;
      if (item.submenu) {
        const openIt = () => openSubmenu(el, item.submenu);
        el.addEventListener("mouseenter", () => {
          if (_hoverSubmenuTimer) clearTimeout(_hoverSubmenuTimer);
          _hoverSubmenuTimer = setTimeout(openIt, 80);
        });
        el.addEventListener("mouseleave", () => {
          if (_hoverSubmenuTimer) {
            clearTimeout(_hoverSubmenuTimer);
            _hoverSubmenuTimer = null;
          }
        });
        el.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          openIt();
        });
      } else {
        el.addEventListener("click", () => {
          closeCardMenu();
          item.onClick?.();
        });
        if (!isSubmenu) {
          el.addEventListener("mouseenter", () => closeSubmenu());
        }
      }
    });
  }
  function openCardMenu(anchor, items) {
    const menu = $("floating-card-menu");
    if (!menu) return;
    const anchorEl = anchor instanceof HTMLElement ? anchor : null;
    if (anchorEl && _activeMenuTrigger === anchorEl) {
      closeCardMenu();
      return;
    }
    closeCardMenu();
    menu.innerHTML = renderMenuItems(items);
    attachItemHandlers(menu, items, false);
    if (anchorEl) {
      anchorEl.classList.add("active");
      _activeMenuTrigger = anchorEl;
    }
    menu.classList.add("open");
    positionFloatingMenu(menu, anchor);
  }
  function openSubmenu(parentItem, items) {
    const sub = $("floating-card-submenu");
    if (!sub) return;
    const menu = $("floating-card-menu");
    menu?.querySelectorAll(".floating-card-menu-item.has-submenu.submenu-open").forEach((el) => el.classList.remove("submenu-open"));
    parentItem.classList.add("submenu-open");
    sub.innerHTML = renderMenuItems(items);
    attachItemHandlers(sub, items, true);
    sub.classList.add("open");
    positionFloatingMenu(sub, parentItem, { preferRight: true });
  }
  function closeSubmenu() {
    $("floating-card-submenu")?.classList.remove("open");
    if (_hoverSubmenuTimer) {
      clearTimeout(_hoverSubmenuTimer);
      _hoverSubmenuTimer = null;
    }
    document.querySelectorAll(".floating-card-menu-item.submenu-open").forEach((el) => el.classList.remove("submenu-open"));
  }
  function closeCardMenu() {
    closeSubmenu();
    $("floating-card-menu")?.classList.remove("open");
    if (_activeMenuTrigger) {
      _activeMenuTrigger.classList.remove("active");
      _activeMenuTrigger = null;
    }
  }
  function openAssetCardMenu(assetId, ev) {
    ev.stopPropagation();
    const a = state.currentPage?.assets?.find((x) => x.id === assetId);
    if (!a) return;
    const url = api.assetUrl(a.id);
    openCardMenu(ev.currentTarget, [
      { label: "Open in new tab", icon: ICON.externalLink, href: url, target: "_blank" },
      { label: "Download", icon: ICON.download, href: url, download: a.original_name },
      { label: "Copy URL", icon: ICON.copy, onClick: () => copyToClipboard(url) },
      { label: "Move to\u2026", icon: ICON.folderMove, onClick: () => openMoveModal("asset", a.id) },
      { label: "Delete", icon: ICON.trash, danger: true, onClick: () => deleteAsset(a.id) }
    ]);
  }
  function openChildCardMenu(pageId, ev) {
    ev.stopPropagation();
    const c = state.pages.find((p) => p.id === pageId);
    if (!c) return;
    const name = c.display_name || c.name;
    openCardMenu(ev.currentTarget, [
      { label: "Open", icon: ICON.arrowRight, onClick: () => navigateTo(c.id) },
      { label: "Rename", icon: ICON.pencil, onClick: () => renamePagePrompt(c.id, name) },
      { label: "Move to\u2026", icon: ICON.folderMove, onClick: () => openMoveModal("page", c.id) },
      { label: "Delete", icon: ICON.trash, danger: true, onClick: () => deletePageConfirm(c.id, name) }
    ]);
  }
  function renderUploadZone(pageId) {
    return `
    <div class="assets-section">
      <div class="section-heading">Upload Files</div>
      <div class="upload-zone" id="upload-zone-${pageId}" onclick="triggerUpload('${pageId}')">
        <div class="upload-zone-icon">\u{1F4CE}</div>
        <div class="upload-zone-text">Drop files here or click to upload</div>
        <div class="upload-zone-hint">.md and .html files become pages \xB7 other files attached as assets</div>
      </div>
      <input type="file" id="upload-input-${pageId}" multiple style="display:none" onchange="handleFileUpload(event,'${pageId}')">
    </div>
  `;
  }
  function setupUploadZone(pageId) {
    const zone = $(`upload-zone-${pageId}`);
    if (!zone) return;
    zone.addEventListener("dragover", (e) => {
      e.preventDefault();
      zone.classList.add("drag-over");
    });
    zone.addEventListener("dragleave", () => zone.classList.remove("drag-over"));
    zone.addEventListener("drop", (e) => {
      e.preventDefault();
      zone.classList.remove("drag-over");
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
    const allFiles = Array.from(files);
    const docFiles = allFiles.filter(
      (f) => f.name.endsWith(".md") || f.name.endsWith(".html") || f.name.endsWith(".htm")
    );
    const assetFiles = allFiles.filter(
      (f) => !f.name.endsWith(".md") && !f.name.endsWith(".html") && !f.name.endsWith(".htm")
    );
    const currentPage = state.pages.find((p) => p.id === pageId);
    const parentId = currentPage?.type === "folder" ? pageId : currentPage?.parent_id || null;
    if (docFiles.length) {
      showToast(`Importing ${docFiles.length} document(s)\u2026`);
      for (const f of docFiles) {
        try {
          const content = await f.text();
          const baseName = f.name.replace(/\.(md|html|htm)$/i, "");
          const fileType = f.name.endsWith(".md") ? "md" : "html";
          await api.createPage({
            name: baseName,
            type: "page",
            file_type: fileType,
            parent_id: parentId,
            content
          });
        } catch (err) {
          showToast(`Failed to import ${f.name}: ${err.message}`, "error");
        }
      }
      await loadPages();
      showToast(`Imported ${docFiles.length} page(s)`);
    }
    if (assetFiles.length) {
      showToast(`Uploading ${assetFiles.length} file(s)\u2026`);
      const form = new FormData();
      for (const f of assetFiles) form.append("files", f);
      form.append("page_id", pageId);
      try {
        await api.uploadFiles(form);
        showToast("Uploaded!");
      } catch (err) {
        showToast("Upload failed: " + err.message, "error");
      }
    }
    await renderPage(pageId);
  }
  var _confirmDeleteResolve = null;
  function showConfirmDelete(filename, title = "Delete asset?") {
    return new Promise((resolve) => {
      _confirmDeleteResolve = resolve;
      const titleEl = document.getElementById("confirm-delete-title");
      if (titleEl) titleEl.textContent = title;
      const msg = $("confirm-delete-msg");
      if (msg) msg.textContent = filename ? `\u201C${filename}\u201D will be permanently deleted.` : "This action cannot be undone.";
      $("confirm-delete-overlay").classList.add("open");
    });
  }
  function closeConfirmDelete(result) {
    $("confirm-delete-overlay").classList.remove("open");
    if (_confirmDeleteResolve) {
      _confirmDeleteResolve(result);
      _confirmDeleteResolve = null;
    }
  }
  async function deleteAsset(assetId) {
    const confirmed = await showConfirmDelete();
    if (!confirmed) return;
    try {
      await api.deleteAsset(assetId);
      showToast("Deleted");
      if (state.currentPageId) await renderPage(state.currentPageId);
    } catch (err) {
      showToast("Delete failed: " + err.message, "error");
    }
  }
  var _ctxFolderId = null;
  function openNewPageModal(defaultType = "page", ctxFolderId) {
    _ctxFolderId = ctxFolderId || null;
    if (defaultType === "image" && !state.aiEnabled) defaultType = "page";
    const imageOption = document.getElementById("type-option-image");
    if (imageOption) {
      imageOption.style.opacity = state.aiEnabled ? "" : "0.4";
      imageOption.style.pointerEvents = state.aiEnabled ? "" : "none";
      imageOption.title = state.aiEnabled ? "" : "Configure an AI profile first";
    }
    $("new-page-overlay").classList.add("open");
    $("new-page-type").value = defaultType;
    updateTypeOptions(defaultType);
    $("new-page-name").value = "";
    $("new-page-ai-prompt").value = "";
    $("new-page-image-prompt").value = "";
    $("new-page-ai-section").style.display = "none";
    $("new-page-image-section").style.display = defaultType === "image" ? "" : "none";
    populateParentSelect(defaultType);
    $("new-page-name").focus();
  }
  function populateParentSelect(type) {
    const select = $("new-page-parent");
    const folders = state.pages.filter((p) => p.type === "folder");
    select.innerHTML = '<option value="">\u2014 Root level \u2014</option>';
    folders.forEach((f) => {
      const opt = document.createElement("option");
      opt.value = f.id;
      opt.textContent = f.display_name || f.name;
      select.appendChild(opt);
    });
    if (type === "page") {
      const ctxId = _ctxFolderId || (state.currentPage?.type === "folder" ? state.currentPage.id : null) || state.currentPage?.parent_id || "";
      select.value = ctxId || "";
    }
  }
  function closeNewPageModal() {
    $("new-page-overlay").classList.remove("open");
  }
  function updateTypeOptions(type) {
    $$(".type-option").forEach((opt) => opt.classList.toggle("selected", opt.dataset.type === type));
    const isFolder = type === "folder";
    const isImage = type === "image";
    $("new-page-file-type-row").style.display = isFolder || isImage ? "none" : "";
    $("new-page-parent-row").style.display = isFolder || isImage ? "none" : "";
    $("new-page-ai-section").style.display = "none";
    $("new-page-image-section").style.display = isImage ? "" : "none";
    const showPrefill = !isFolder && !isImage && state.aiEnabled;
    $("new-page-ai-prefill-row").style.display = showPrefill ? "" : "none";
    if (!showPrefill) $("new-page-ai-section").style.display = "none";
    const card = $("new-page-ai-prefill-row");
    if (card) {
      card.classList.remove("active");
      card.dataset.active = "false";
    }
    const nameInput = $("new-page-name");
    const nameLabel = nameInput.previousElementSibling;
    if (isImage) {
      nameInput.placeholder = "Image name\u2026";
      if (nameLabel) nameLabel.textContent = "Name";
    } else if (isFolder) {
      nameInput.placeholder = "Folder name\u2026";
      if (nameLabel) nameLabel.textContent = "Name";
    } else {
      nameInput.placeholder = "Page name\u2026";
      if (nameLabel) nameLabel.textContent = "Name";
    }
    if (isImage) {
      setTimeout(() => $("new-page-image-prompt").focus(), 50);
    }
  }
  function selectType(type) {
    $("new-page-type").value = type;
    updateTypeOptions(type);
  }
  function toggleAiFill() {
    const section = $("new-page-ai-section");
    const card = $("new-page-ai-prefill-row");
    const isActive = card?.dataset.active === "true";
    if (isActive) {
      section.style.display = "none";
      if (card) {
        card.dataset.active = "false";
        card.classList.remove("active");
      }
    } else {
      section.style.display = "";
      if (card) {
        card.dataset.active = "true";
        card.classList.add("active");
      }
      $("new-page-ai-prompt").focus();
    }
  }
  async function submitNewPage() {
    const rawName = $("new-page-name").value.trim();
    const type = $("new-page-type").value;
    const fileType = $("new-page-file-type").value;
    const aiPrompt = $("new-page-ai-prompt").value.trim();
    const imagePrompt = $("new-page-image-prompt").value.trim();
    if (type === "image") {
      if (!imagePrompt) {
        showToast("Please describe the image", "error");
        return;
      }
      const btn2 = $("new-page-submit");
      btn2.disabled = true;
      btn2.textContent = "Generating\u2026";
      showMascotLoading("Generating image\u2026", "Yoyo is painting your idea");
      try {
        const page_id = state.currentPageId ?? void 0;
        await api.generateImg({ prompt: imagePrompt, page_id });
        closeNewPageModal();
        if (state.currentPageId) await renderPage(state.currentPageId);
        showToast("Image generated!");
      } catch (err) {
        showToast("Failed: " + err.message, "error");
      } finally {
        hideMascotLoading();
        btn2.disabled = false;
        btn2.textContent = "Create";
      }
      return;
    }
    if (!rawName) {
      showToast("Please enter a name", "error");
      return;
    }
    let parentId = null;
    let finalName = rawName;
    if (type === "folder") {
      if (_ctxFolderId) {
        parentId = _ctxFolderId;
        finalName = rawName;
      } else {
        parentId = null;
        const topFolders = state.pages.filter((p) => p.type === "folder" && !p.parent_id);
        const nextNum = String(topFolders.length + 1).padStart(2, "0");
        finalName = `${nextNum} - ${rawName}`;
      }
    } else {
      const sel = $("new-page-parent").value;
      parentId = sel || null;
    }
    const btn = $("new-page-submit");
    btn.disabled = true;
    btn.textContent = "Creating\u2026";
    try {
      let content = "";
      if (type === "page" && aiPrompt) {
        showMascotLoading("Generating content\u2026", "Yoyo is writing your page");
        try {
          const { content: gen } = await api.generate({ prompt: aiPrompt, type: fileType });
          content = gen;
        } finally {
          hideMascotLoading();
        }
      }
      const { page } = await api.createPage({
        name: finalName,
        type,
        file_type: type === "folder" ? void 0 : fileType,
        parent_id: parentId,
        content
      });
      closeNewPageModal();
      await loadPages();
      if (type === "folder") {
        const targetId = parentId || page.id;
        if (state.currentPageId === targetId) {
          await renderPage(targetId);
          renderSidebar();
        } else {
          await navigateTo(targetId);
        }
      } else {
        await navigateTo(page.id);
      }
      showToast(`${type === "folder" ? "Folder" : "Page"} created!`);
    } catch (err) {
      showToast("Failed: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Create";
    }
  }
  function showWelcome() {
    clearTimeout(saveTimer);
    if (state.wysiwyg) {
      try {
        state.wysiwyg.destroy();
      } catch {
      }
      state.wysiwyg = null;
    }
    history.replaceState(null, "", window.location.pathname);
    state.currentPageId = null;
    state.currentPage = null;
    state.editMode = false;
    const content = $("content-area");
    content.className = "content-area";
    content.innerHTML = `
    <div class="welcome-state fade-in">
      <div class="welcome-icon">\u2726</div>
      <h1 class="welcome-title">Welcome to yo\u0131nko</h1>
      <p class="welcome-sub">
        Create folders and pages to organize your knowledge.<br>
        All pages are stored as <strong>.md</strong> and <strong>.html</strong> files in <code style="font-family:'JetBrains Mono',monospace;font-size:13px;background:var(--butter);padding:2px 6px;border-radius:4px;">data/pages/</code>
      </p>
      <div style="display:flex;gap:10px;margin-top:8px;">
        <button class="btn btn-primary" onclick="openNewPageModal('folder')">\u{1F4C1} New Folder</button>
        <button class="btn btn-ghost" onclick="openNewPageModal('page')">\u{1F4DD} New Page</button>
      </div>
    </div>
  `;
    const badge = document.getElementById("topbar-badge");
    if (badge) badge.textContent = "";
    const titleEl = document.getElementById("page-title");
    if (titleEl) titleEl.value = "";
    const bcParent = document.getElementById("bc-parent");
    if (bcParent) bcParent.textContent = "yo\u0131nko";
    document.getElementById("html-edit-btn")?.classList.add("hidden");
    hideSaveState();
  }
  var _renameId = "";
  var _deleteId = "";
  function renamePagePrompt(id, currentDisplayName) {
    _renameId = id;
    const input = $("rename-input");
    input.value = currentDisplayName;
    $("rename-overlay").classList.add("open");
    setTimeout(() => input.select(), 80);
    input.onkeydown = (e) => {
      if (e.key === "Enter") submitRename();
      if (e.key === "Escape") $("rename-overlay").classList.remove("open");
    };
  }
  async function submitRename() {
    const newName = $("rename-input").value.trim();
    if (!newName) return;
    $("rename-overlay").classList.remove("open");
    const oldId = _renameId;
    const oldRenamedPath = state.pages.find((p) => p.id === oldId)?.path ?? "";
    const viewedOldPath = state.currentPage?.path ?? "";
    try {
      const res = await api.updatePage(oldId, { name: newName });
      const newId = res.page.id;
      const newRenamedPath = res.page.path;
      await loadPages();
      let targetId = null;
      if (state.currentPageId === oldId) {
        targetId = newId;
      } else if (oldRenamedPath && newRenamedPath && viewedOldPath && viewedOldPath.startsWith(oldRenamedPath + "/")) {
        const remapped = newRenamedPath + viewedOldPath.slice(oldRenamedPath.length);
        const target = state.pages.find((p) => p.path === remapped);
        if (target) targetId = target.id;
      }
      if (targetId) {
        state.currentPageId = null;
        await navigateTo(targetId);
      } else if (state.currentPageId && state.pages.find((p) => p.id === state.currentPageId)) {
        await renderPage(state.currentPageId);
      }
      showToast("Renamed!");
    } catch (err) {
      showToast("Rename failed: " + err.message, "error");
    }
  }
  function deletePageConfirm(id, name) {
    _deleteId = id;
    $("delete-page-name").textContent = `"${name}"`;
    $("delete-overlay").classList.add("open");
  }
  var _moveTarget = null;
  var _moveSelection = null;
  function buildFolderOptionsTree(blockedIds) {
    const folders = state.pages.filter((p) => p.type === "folder" && !blockedIds.has(p.id));
    const byParent = /* @__PURE__ */ new Map();
    for (const f of folders) {
      const key = f.parent_id ?? null;
      const list = byParent.get(key) ?? [];
      list.push(f);
      byParent.set(key, list);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => (a.display_name || a.name).localeCompare(b.display_name || b.name));
    }
    const out = [];
    const walk = (parentId, prefix, depth) => {
      const list = byParent.get(parentId) ?? [];
      for (const f of list) {
        const name = f.display_name || f.name;
        const fullPath = prefix ? `${prefix} / ${name}` : name;
        out.push({ id: f.id, shortLabel: name, fullLabel: fullPath, depth });
        walk(f.id, fullPath, depth + 1);
      }
    };
    walk(null, "", 0);
    return out;
  }
  function renderMovePanel(options) {
    const panel = $("move-target-panel");
    if (!panel) return;
    if (!options.length) {
      panel.innerHTML = `<div class="custom-select-empty">No folders available</div>`;
      return;
    }
    panel.innerHTML = options.map((opt, i) => {
      const indent = `<span class="custom-select-option-indent" style="--depth:${opt.depth * 14}px"></span>`;
      const icon = `<span class="custom-select-option-icon" aria-hidden="true">${ICON.folder}</span>`;
      const badge = opt.isCurrent ? `<span class="custom-select-option-current">current</span>` : "";
      const disabled = opt.isCurrent ? "disabled" : "";
      return `<button type="button" class="custom-select-option" data-value="${esc(opt.value)}" data-label="${esc(opt.fullLabel)}" data-idx="${i}" data-depth="${opt.depth}" ${disabled}>${indent}${icon}<span class="custom-select-label">${esc(opt.shortLabel)}</span>${badge}</button>`;
    }).join("");
    panel.querySelectorAll(".custom-select-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        if (btn.disabled) return;
        const value = btn.dataset.value || "";
        const label = btn.dataset.label || "";
        _moveSelection = { value, label };
        const labelEl = $("move-target-label");
        labelEl.textContent = label;
        labelEl.classList.remove("placeholder");
        panel.querySelectorAll(".custom-select-option.selected").forEach((el) => el.classList.remove("selected"));
        btn.classList.add("selected");
        closeMoveTargetPanel();
      });
    });
  }
  function positionMoveTargetPanel() {
    const wrapper = $("move-target-select");
    if (!wrapper.classList.contains("open")) return;
    const trigger = $("move-target-trigger");
    const panel = $("move-target-panel");
    panel.style.top = "0px";
    panel.style.left = "0px";
    panel.style.width = `${trigger.getBoundingClientRect().width}px`;
    const tRect = trigger.getBoundingClientRect();
    const pRect = panel.getBoundingClientRect();
    const margin = 8;
    const gap = 6;
    let top = tRect.bottom + gap;
    if (top + pRect.height > window.innerHeight - margin) {
      const aboveTop = tRect.top - pRect.height - gap;
      if (aboveTop >= margin) top = aboveTop;
      else top = window.innerHeight - pRect.height - margin;
    }
    let left = tRect.left;
    if (left + pRect.width > window.innerWidth - margin) {
      left = window.innerWidth - pRect.width - margin;
    }
    if (left < margin) left = margin;
    if (top < margin) top = margin;
    panel.style.top = `${top}px`;
    panel.style.left = `${left}px`;
  }
  function closeMoveTargetPanel() {
    $("move-target-select")?.classList.remove("open");
  }
  function openMoveModal(kind, id) {
    closeCardMenu();
    const hint = $("move-item-hint");
    const labelEl = $("move-target-label");
    $("move-target-select").classList.remove("open");
    _moveSelection = null;
    labelEl.textContent = "\u2014 Pick a folder \u2014";
    labelEl.classList.add("placeholder");
    const options = [];
    if (kind === "page") {
      const p = state.pages.find((x) => x.id === id);
      if (!p) return;
      const itemName = p.display_name || p.name;
      const currentParentId = p.parent_id ?? null;
      const blocked = /* @__PURE__ */ new Set([id]);
      const collect = (parentId) => {
        state.pages.forEach((c) => {
          if (c.parent_id === parentId && !blocked.has(c.id)) {
            blocked.add(c.id);
            if (c.type === "folder") collect(c.id);
          }
        });
      };
      collect(id);
      options.push({
        value: "",
        shortLabel: "Root level",
        fullLabel: "Root level",
        depth: 0,
        isCurrent: currentParentId === null
      });
      for (const f of buildFolderOptionsTree(blocked)) {
        options.push({
          value: f.id,
          shortLabel: f.shortLabel,
          fullLabel: f.fullLabel,
          depth: f.depth,
          isCurrent: f.id === currentParentId
        });
      }
      hint.textContent = `Moving "${itemName}" to a different folder.`;
      _moveTarget = { kind: "page", id, name: itemName, currentParentId };
    } else {
      const a = state.currentPage?.assets?.find((x) => x.id === id);
      if (!a) return;
      const itemName = a.original_name;
      const currentPageId = a.page_id ?? null;
      for (const f of buildFolderOptionsTree(/* @__PURE__ */ new Set())) {
        options.push({
          value: f.id,
          shortLabel: f.shortLabel,
          fullLabel: f.fullLabel,
          depth: f.depth,
          isCurrent: f.id === currentPageId
        });
      }
      hint.textContent = `Moving "${itemName}" to a different folder.`;
      _moveTarget = { kind: "asset", id, name: itemName, currentPageId };
    }
    renderMovePanel(options);
    $("move-item-overlay").classList.add("open");
  }
  function closeMoveModal() {
    $("move-item-overlay").classList.remove("open");
    $("move-target-select").classList.remove("open");
    _moveTarget = null;
    _moveSelection = null;
  }
  async function submitMove() {
    const t = _moveTarget;
    if (!t) return;
    if (!_moveSelection) {
      showToast("Pick a destination", "error");
      return;
    }
    const targetValue = _moveSelection.value;
    const oldMovedPath = t.kind === "page" ? state.pages.find((p) => p.id === t.id)?.path ?? "" : "";
    const viewedOldPath = state.currentPage?.path ?? "";
    closeMoveModal();
    try {
      let newMovedPath = "";
      if (t.kind === "page") {
        const res = await api.movePage(t.id, targetValue || null);
        newMovedPath = res.page.path;
      } else {
        if (!targetValue) {
          showToast("Pick a destination", "error");
          return;
        }
        await api.moveAsset(t.id, targetValue);
      }
      await loadPages();
      let targetId = null;
      if (t.kind === "page") {
        if (state.currentPageId === t.id) {
          const moved = state.pages.find((p) => p.path === newMovedPath);
          if (moved) targetId = moved.id;
        } else if (oldMovedPath && newMovedPath && viewedOldPath && viewedOldPath.startsWith(oldMovedPath + "/")) {
          const remapped = newMovedPath + viewedOldPath.slice(oldMovedPath.length);
          const target = state.pages.find((p) => p.path === remapped);
          if (target) targetId = target.id;
        }
      }
      if (targetId) {
        state.currentPageId = null;
        await navigateTo(targetId);
      } else if (state.currentPageId && state.pages.find((p) => p.id === state.currentPageId)) {
        await renderPage(state.currentPageId);
      } else if (state.currentPageId) {
        showWelcome();
      }
      showToast("Moved!");
    } catch (err) {
      showToast("Move failed: " + err.message, "error");
    }
  }
  async function submitDelete() {
    $("delete-overlay").classList.remove("open");
    const wasCurrent = state.currentPageId === _deleteId;
    if (wasCurrent) showWelcome();
    state.pages = state.pages.filter((p) => p.id !== _deleteId);
    try {
      await api.deletePage(_deleteId);
      await loadPages();
      showToast("Deleted.");
    } catch (err) {
      showToast("Delete failed: " + err.message, "error");
      await loadPages();
    }
  }
  function showCtxMenu(e, page) {
    e.preventDefault();
    e.stopPropagation();
    const me = e;
    const displayName = page.display_name || page.name;
    const items = [];
    if (page.type === "page") {
      items.push({ label: "Open", icon: ICON.arrowRight, onClick: () => navigateTo(page.id) });
    }
    items.push({ label: "Rename", icon: ICON.pencil, onClick: () => renamePagePrompt(page.id, displayName) });
    if (page.type === "folder") {
      items.push({
        label: "Add\u2026",
        icon: ICON.plus,
        submenu: [
          { label: "Page", icon: ICON.fileText, onClick: () => openNewPageModal("page", page.id) },
          { label: "Folder", icon: ICON.folder, onClick: () => openNewPageModal("folder", page.id) }
        ]
      });
    }
    const isMovable = page.type === "page" || page.type === "folder" && !!page.parent_id;
    if (isMovable) {
      items.push({ label: "Move to\u2026", icon: ICON.folderMove, onClick: () => openMoveModal("page", page.id) });
    }
    items.push({ label: "Delete", icon: ICON.trash, danger: true, onClick: () => deletePageConfirm(page.id, displayName) });
    openCardMenu({ x: me.clientX, y: me.clientY }, items);
  }
  var titleTimer;
  function onTitleChange(e) {
    clearTimeout(titleTimer);
    titleTimer = setTimeout(async () => {
      if (!state.currentPageId) return;
      const val = e.target.value.trim();
      if (!val) return;
      try {
        const res = await api.updatePage(state.currentPageId, { name: val });
        if (res.page?.id && res.page.id !== state.currentPageId) {
          state.currentPageId = res.page.id;
          window.location.hash = `page/${res.page.id}`;
        }
        await loadPages();
      } catch {
      }
    }, 900);
  }
  function toggleChat() {
    if (!state.aiEnabled) return;
    state.chatOpen = !state.chatOpen;
    $("chat-drawer").classList.toggle("open", state.chatOpen);
    if (state.chatOpen && state.currentPageId) loadChatHistory();
  }
  function toggleSidebar() {
    const sidebar = $("sidebar");
    const collapsed = sidebar.classList.toggle("collapsed");
    localStorage.setItem("yk-sidebar-collapsed", collapsed ? "1" : "0");
  }
  async function loadChatHistory() {
    if (!state.currentPageId) return;
    try {
      const { messages } = await api.getChatHistory(state.currentPageId);
      state.chatMessages = messages.map((m) => ({ role: m.role, content: m.content }));
      renderChatMessages();
    } catch {
    }
  }
  function renderChatMessages() {
    const container = $("chat-messages");
    if (!state.chatMessages.length) {
      container.innerHTML = `<div style="text-align:center;padding:40px 16px;color:var(--text-dim);font-size:14px;"><img src="/mascot.svg" alt="Yoinko" class="chat-empty-mascot"><div>Ask me anything about this page,<br>or request changes!</div></div>`;
      return;
    }
    container.innerHTML = state.chatMessages.map((m) => `
    <div class="chat-msg ${m.role}">
      ${m.role === "assistant" ? '<img src="/mascot.svg" alt="AI" class="chat-msg-avatar">' : ""}
      <div class="chat-msg-bubble">
        <div class="chat-msg-role">${m.role === "user" ? "You" : "Yoyo"}</div>
        <div class="chat-msg-content">${m.role === "assistant" ? renderMarkdownSimple(m.content) : esc(m.content)}</div>
      </div>
    </div>
  `).join("");
    container.scrollTop = container.scrollHeight;
  }
  function renderMarkdownSimple(text) {
    const codeBlocks = [];
    const placeholder = "\0CB\0";
    const withPlaceholders = text.replace(/```([\s\S]*?)```/g, (_match, code) => {
      const cleaned = code.replace(/^[^\n]*\n/, "");
      codeBlocks.push(cleaned);
      return placeholder;
    });
    let safe = esc(withPlaceholders);
    safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/\n/g, "<br>");
    let i = 0;
    safe = safe.replace(new RegExp(placeholder.replace(/\x00/g, "\\x00"), "g"), () => {
      const code = esc(codeBlocks[i++] ?? "");
      return `<pre style="background:var(--surface-3);padding:8px;border-radius:6px;font-size:12px;overflow-x:auto;margin:6px 0"><code>${code}</code></pre>`;
    });
    return safe;
  }
  async function sendChatMessage() {
    const input = $("chat-input");
    const text = input.value.trim();
    if (!text || state.chatStreaming) return;
    input.value = "";
    input.style.height = "auto";
    state.chatMessages.push({ role: "user", content: text });
    renderChatMessages();
    const typingId = "typing-" + Date.now();
    $("chat-messages").innerHTML += `
    <div class="chat-msg assistant" id="${typingId}">
      <img src="/mascot.svg" alt="AI" class="chat-msg-avatar">
      <div class="chat-msg-bubble">
        <div class="chat-msg-role">Yoyo</div>
        <div class="chat-typing"><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div></div>
      </div>
    </div>
  `;
    $("chat-messages").scrollTop = $("chat-messages").scrollHeight;
    state.chatStreaming = true;
    $("chat-send-btn").disabled = true;
    let reply = "";
    const pageContent = state.currentPage?.content || "";
    await api.chatStream(
      state.chatMessages.filter((m) => m.role !== "system"),
      state.currentPageId,
      pageContent,
      {
        onChunk: (chunk) => {
          reply += chunk;
          const el = document.getElementById(typingId);
          if (el) {
            const inner = el.querySelector(".chat-msg-content, .chat-typing");
            if (inner) inner.outerHTML = `<div class="chat-msg-content">${renderMarkdownSimple(reply)}</div>`;
          }
          $("chat-messages").scrollTop = $("chat-messages").scrollHeight;
        },
        onDone: () => {
          state.chatMessages.push({ role: "assistant", content: reply });
          state.chatStreaming = false;
          $("chat-send-btn").disabled = false;
          renderChatMessages();
        },
        onError: (err) => {
          state.chatStreaming = false;
          $("chat-send-btn").disabled = false;
          showToast("Chat error: " + err, "error");
          document.getElementById(typingId)?.remove();
        }
      }
    );
  }
  function clearChat() {
    state.chatMessages = [];
    renderChatMessages();
    if (state.currentPageId) {
      api.deleteChatHistory(state.currentPageId).catch(() => {
      });
    }
  }
  async function applyAiSuggestion() {
    if (!state.chatMessages.length || !state.currentPageId) return;
    const last = [...state.chatMessages].reverse().find((m) => m.role === "assistant");
    if (!last) return;
    const isMd = state.currentPage?.file_type === "md";
    const sep = isMd ? "\n\n---\n\n" : "\n\n<!-- section -->\n\n";
    const newContent = (state.currentPage?.content || "") + sep + last.content;
    try {
      await api.updatePage(state.currentPageId, { content: newContent });
      if (state.currentPage) state.currentPage.content = newContent;
      await renderPage(state.currentPageId);
      showToast("Content applied!");
    } catch {
    }
  }
  var profilesList = [];
  var activeProfileId = "";
  var selectedProfileId = "";
  var PROVIDER_ICONS = {
    openai: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.998 5.998 0 0 0-3.998 2.9 6.042 6.042 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>',
    gemini: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M12 0C5.352 0 0 5.352 0 12s5.352 12 12 12 12-5.352 12-12S18.648 0 12 0zm0 2.4a9.6 9.6 0 0 1 9.6 9.6c0 .12-.012.24-.012.348-1.836-3.468-5.46-5.748-9.588-5.748S4.248 8.88 2.412 12.348A9.355 9.355 0 0 1 2.4 12 9.6 9.6 0 0 1 12 2.4zm0 19.2A9.6 9.6 0 0 1 2.4 12c0-.12.012-.24.012-.348C4.248 15.12 7.872 17.4 12 17.4s7.752-2.28 9.588-5.748c0 .108.012.228.012.348a9.6 9.6 0 0 1-9.6 9.6z"/></svg>',
    claude: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M17.304 4.044l-3.672 12.348h-2.88L7.08 4.044h2.736l2.232 8.688 2.328-8.688zM5.4 17.604h13.2v2.352H5.4z"/></svg>',
    "openai-compatible": '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><path d="M14 14h4v4h4M14 18h4"/></svg>'
  };
  var PROVIDER_DEFAULTS = {
    openai: "gpt-4o-mini",
    gemini: "gemini-2.0-flash",
    claude: "claude-3-5-haiku-20241022",
    "openai-compatible": ""
  };
  async function openSettings() {
    $("settings-overlay").classList.add("open");
    try {
      const { profiles, activeId } = await api.getProfiles();
      profilesList = profiles;
      activeProfileId = activeId;
      if (profiles.length === 0) {
        const { settings } = await api.getSettings();
        if (settings.llm_provider || settings.llm_api_key) {
          const migrated = {
            id: crypto.randomUUID(),
            name: "Default",
            provider: settings.llm_provider || "openai",
            model: settings.llm_model || "",
            api_key: settings.llm_api_key || "",
            base_url: settings.llm_base_url || "",
            image_model: settings.image_model || "dall-e-3"
          };
          await api.saveProfile(migrated);
          await api.setActiveProfile(migrated.id);
          const refreshed = await api.getProfiles();
          profilesList = refreshed.profiles;
          activeProfileId = refreshed.activeId;
        }
      }
      renderProfilesList();
      if (profilesList.length > 0) {
        selectProfileItem(activeProfileId || profilesList[0].id);
      } else {
        showEmptyState();
      }
    } catch {
      showToast("Failed to load settings", "error");
    }
  }
  function closeSettings() {
    $("settings-overlay").classList.remove("open");
    void applyAIVisibility();
  }
  function renderProfilesList() {
    const list = $("profiles-list");
    list.innerHTML = profilesList.map((p) => `
    <div class="profile-item ${p.id === selectedProfileId ? "selected" : ""}" onclick="selectProfileItem('${p.id}')">
      <span class="profile-item-icon">${PROVIDER_ICONS[p.provider] || "\u{1F916}"}</span>
      <span class="profile-item-name">${escapeHtml(p.name)}</span>
      ${p.id === activeProfileId ? '<span class="profile-active-badge">active</span>' : ""}
    </div>
  `).join("");
  }
  function selectProfileItem(id) {
    selectedProfileId = id;
    renderProfilesList();
    const profile = profilesList.find((p) => p.id === id);
    if (!profile) return;
    $("profile-form").style.display = "";
    $("profile-empty").style.display = "none";
    $("profile-name").value = profile.name;
    $("settings-provider").value = profile.provider || "openai";
    $("settings-model").value = profile.model || "";
    $("settings-api-key").value = "";
    $("settings-api-key").placeholder = profile.api_key_masked || "Enter API key\u2026";
    $("settings-base-url").value = profile.base_url || "";
    $("settings-image-model").value = profile.image_model || "";
    updateProviderCards(profile.provider || "openai");
    updateProviderUI(profile.provider || "openai");
    const activeBtn = $("set-active-btn");
    if (id === activeProfileId) {
      activeBtn.textContent = "\u2605 Active";
      activeBtn.disabled = true;
      activeBtn.className = "btn btn-danger btn-sm";
    } else {
      activeBtn.textContent = "\u2605 Set Active";
      activeBtn.disabled = false;
      activeBtn.className = "btn btn-primary btn-sm";
    }
  }
  function showEmptyState() {
    $("profile-form").style.display = "none";
    $("profile-empty").style.display = "";
  }
  function addNewProfile() {
    const id = crypto.randomUUID();
    const newProfile = {
      id,
      name: `Profile ${profilesList.length + 1}`,
      provider: "openai",
      model: "gpt-4o-mini",
      api_key: "",
      base_url: "",
      image_model: "dall-e-3",
      api_key_masked: ""
    };
    profilesList.push(newProfile);
    renderProfilesList();
    selectProfileItem(id);
    $("profile-name").focus();
  }
  async function saveCurrentProfile() {
    const profile = profilesList.find((p) => p.id === selectedProfileId);
    if (!profile) return;
    const updated = {
      id: profile.id,
      name: $("profile-name").value.trim() || profile.name,
      provider: $("settings-provider").value,
      model: $("settings-model").value,
      api_key: $("settings-api-key").value || "",
      base_url: $("settings-base-url").value,
      image_model: $("settings-image-model").value.trim()
    };
    try {
      await api.saveProfile(updated);
      const { profiles, activeId } = await api.getProfiles();
      profilesList = profiles;
      activeProfileId = activeId;
      renderProfilesList();
      selectProfileItem(profile.id);
      showToast("Profile saved!");
    } catch (err) {
      showToast("Save failed: " + err.message, "error");
    }
  }
  async function deleteCurrentProfile() {
    if (!selectedProfileId) return;
    const profile = profilesList.find((p) => p.id === selectedProfileId);
    if (!profile) return;
    const nameEl = document.getElementById("delete-profile-name");
    if (nameEl) nameEl.textContent = `"${profile.name}"`;
    document.getElementById("delete-profile-overlay")?.classList.add("open");
  }
  async function confirmDeleteProfile() {
    document.getElementById("delete-profile-overlay")?.classList.remove("open");
    if (!selectedProfileId) return;
    try {
      await api.deleteProfile(selectedProfileId);
      const { profiles, activeId } = await api.getProfiles();
      profilesList = profiles;
      activeProfileId = activeId;
      renderProfilesList();
      if (profilesList.length > 0) {
        selectProfileItem(activeProfileId || profilesList[0].id);
      } else {
        selectedProfileId = "";
        showEmptyState();
      }
      showToast("Profile deleted");
    } catch (err) {
      showToast("Delete failed: " + err.message, "error");
    }
  }
  async function setActiveCurrentProfile() {
    if (!selectedProfileId || selectedProfileId === activeProfileId) return;
    try {
      await api.setActiveProfile(selectedProfileId);
      activeProfileId = selectedProfileId;
      renderProfilesList();
      selectProfileItem(selectedProfileId);
      const name = profilesList.find((p) => p.id === selectedProfileId)?.name || "";
      showToast(`"${name}" is now active`);
    } catch (err) {
      showToast("Failed: " + err.message, "error");
    }
  }
  function selectProvider(p) {
    $("settings-provider").value = p;
    updateProviderCards(p);
    updateProviderUI(p);
    const modelEl = $("settings-model");
    if (!modelEl.value) modelEl.value = PROVIDER_DEFAULTS[p] || "";
  }
  function updateProviderCards(p) {
    $$(".provider-card").forEach((c) => c.classList.toggle("selected", c.dataset.provider === p));
  }
  function updateProviderUI(p) {
    $("base-url-row").style.display = p === "openai-compatible" ? "" : "none";
  }
  function openLightbox(src, name) {
    $("lightbox-img").src = src;
    $("lightbox-name").textContent = name || "";
    $("lightbox").classList.add("open");
  }
  function closeLightbox() {
    $("lightbox").classList.remove("open");
  }
  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(window.location.origin + text);
      showToast("URL copied!");
    } catch {
      showToast("Copy failed", "error");
    }
  }
  var toastTimer;
  function showToast(msg, type = "info") {
    const toast = $("toast");
    toast.querySelector(".toast-text").textContent = msg;
    toast.className = `toast ${type === "error" ? "error" : ""} show`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3500);
  }
  var searchTimer;
  function onSearch() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderSidebar(), 200);
  }
  function renderMarkdown(text) {
    if (typeof marked === "undefined") return `<pre>${esc(text || "")}</pre>`;
    const result = marked.parse(text || "", { async: false, gfm: true, breaks: false });
    const html = typeof result === "string" ? result : `<pre>${esc(text || "")}</pre>`;
    const wrapper = document.createElement("div");
    wrapper.innerHTML = html;
    for (const ul of Array.from(wrapper.querySelectorAll("ul"))) {
      const directLis = Array.from(ul.children).filter(
        (c) => c.tagName === "LI"
      );
      if (!directLis.length) continue;
      const isTaskList = directLis.some(
        (li) => li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]')
      );
      if (!isTaskList) continue;
      ul.setAttribute("data-type", "taskList");
      for (const li of directLis) {
        const cb = li.querySelector(
          ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]'
        );
        if (!cb) continue;
        const isChecked = cb.hasAttribute("checked") || cb.checked;
        let leadingHtml = "";
        const leadingP = li.querySelector(":scope > p");
        if (leadingP && leadingP.contains(cb)) {
          cb.remove();
          leadingHtml = leadingP.innerHTML.trim();
          leadingP.remove();
        } else {
          cb.remove();
          const buf = document.createElement("div");
          for (const child of Array.from(li.childNodes)) {
            if (child.nodeType === Node.ELEMENT_NODE) {
              const tag = child.tagName;
              if (tag === "UL" || tag === "OL") break;
            }
            buf.appendChild(child);
          }
          leadingHtml = buf.innerHTML.trim();
        }
        li.setAttribute("data-type", "taskItem");
        li.setAttribute("data-checked", isChecked ? "true" : "false");
        const label = document.createElement("label");
        label.innerHTML = `<input type="checkbox"${isChecked ? " checked" : ""}><span>${leadingHtml}</span>`;
        li.insertBefore(label, li.firstChild);
      }
    }
    return wrapper.innerHTML;
  }
  function esc(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function setupEventListeners() {
    $("theme-btn")?.addEventListener("click", toggleTheme);
    $("sidebar-search").addEventListener("input", onSearch);
    $("btn-new-page").addEventListener("click", () => openNewPageModal("page"));
    $("btn-new-folder").addEventListener("click", () => openNewPageModal("folder"));
    $("settings-btn").addEventListener("click", openSettings);
    $("chat-toggle").addEventListener("click", toggleChat);
    $("chat-close-btn").addEventListener("click", toggleChat);
    $("chat-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });
    $("chat-input").addEventListener("input", function() {
      this.style.height = "auto";
      this.style.height = Math.min(this.scrollHeight, 120) + "px";
    });
    document.addEventListener("click", (e) => {
      if (state.chatOpen && !e.target.closest(".chat-drawer") && !e.target.closest("#chat-toggle")) {
        state.chatOpen = false;
        $("chat-drawer").classList.remove("open");
      }
      const target = e.target;
      if (!target.closest("#floating-card-menu") && !target.closest(".asset-menu-btn") && !target.closest(".child-card-menu-btn")) {
        closeCardMenu();
      }
    });
    window.addEventListener("scroll", closeCardMenu, true);
    window.addEventListener("resize", closeCardMenu);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && _activeMenuTrigger) closeCardMenu();
    });
    $("confirm-delete-cancel").addEventListener("click", () => closeConfirmDelete(false));
    $("confirm-delete-ok").addEventListener("click", () => closeConfirmDelete(true));
    $("confirm-delete-overlay").addEventListener("click", (e) => {
      if (e.target === $("confirm-delete-overlay")) closeConfirmDelete(false);
    });
    $("new-page-overlay").addEventListener("click", (e) => {
      if (e.target === $("new-page-overlay")) closeNewPageModal();
    });
    $("settings-overlay").addEventListener("click", (e) => {
      if (e.target === $("settings-overlay")) closeSettings();
    });
    $("lightbox").addEventListener("click", (e) => {
      if (e.target === $("lightbox")) closeLightbox();
    });
    $("move-item-overlay").addEventListener("click", (e) => {
      if (e.target === $("move-item-overlay")) closeMoveModal();
    });
    $("move-target-trigger").addEventListener("click", (e) => {
      e.stopPropagation();
      const wrapper = $("move-target-select");
      const wasOpen = wrapper.classList.contains("open");
      wrapper.classList.toggle("open");
      if (!wasOpen) positionMoveTargetPanel();
    });
    document.addEventListener("click", (e) => {
      const wrapper = $("move-target-select");
      const panel = $("move-target-panel");
      if (!wrapper) return;
      const target = e.target;
      if (!wrapper.contains(target) && !panel.contains(target)) {
        wrapper.classList.remove("open");
      }
    });
    window.addEventListener("resize", () => positionMoveTargetPanel());
    window.addEventListener("scroll", () => positionMoveTargetPanel(), true);
    $("create-project-overlay").addEventListener("click", (e) => {
      if (e.target === $("create-project-overlay")) closeCreateProjectModal();
    });
    $("rename-project-overlay").addEventListener("click", (e) => {
      if (e.target === $("rename-project-overlay")) closeRenameProjectModal();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeLightbox();
        closeConfirmDelete(false);
        closeCreateProjectModal();
        closeRenameProjectModal();
      }
    });
    $("page-title").addEventListener("input", onTitleChange);
    $("new-page-type").addEventListener("change", (e) => updateTypeOptions(e.target.value));
    document.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "p" && !e.target.closest(".notion-textarea, #editor-textarea, #chat-input, .form-input, .form-textarea")) {
        e.preventDefault();
        if (state.currentPage && state.currentPage.file_type === "md") toggleEditMode();
      }
    });
  }
  document.addEventListener("DOMContentLoaded", init);
})();
//# sourceMappingURL=app.bundle.js.map
