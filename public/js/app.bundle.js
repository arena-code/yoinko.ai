"use strict";
var NotasApp = (() => {
  // src/client/api.ts
  var API_BASE = "/api";
  async function request(method, path, body, isFormData = false) {
    const opts = {
      method,
      headers: isFormData ? {} : { "Content-Type": "application/json" }
    };
    if (body !== void 0) {
      opts.body = isFormData ? body : JSON.stringify(body);
    }
    const res = await fetch(`${API_BASE}${path}`, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error ?? `HTTP ${res.status}`);
    }
    return res.json();
  }
  var api = {
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
    // ── AI ─────────────────────────────────────────────────────────────────────
    generate: (data) => request("POST", "/ai/generate", data),
    generateImg: (data) => request("POST", "/ai/image", data),
    getChatHistory: (pageId) => request("GET", `/ai/chat/history?page_id=${pageId}`),
    // Streaming chat — Server-Sent Events via fetch
    async chatStream(messages, pageId, pageContent, { onChunk, onDone, onError }) {
      try {
        const res = await fetch(`${API_BASE}/ai/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages, page_id: pageId, page_content: pageContent })
        });
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
    currentPageId: null,
    currentPage: null,
    theme: "dark",
    chatOpen: false,
    chatMessages: [],
    chatStreaming: false,
    expandedFolders: /* @__PURE__ */ new Set(),
    settings: {},
    wysiwyg: null
  };
  var $ = (id) => document.getElementById(id);
  var $$ = (sel) => document.querySelectorAll(sel);
  async function init() {
    await loadSettings();
    applyTheme(state.theme);
    await loadPages();
    setupEventListeners();
    handleHashRoute();
    window.addEventListener("hashchange", handleHashRoute);
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
  }
  async function loadSettings() {
    try {
      const { settings } = await api.getSettings();
      state.settings = settings;
      state.theme = settings.theme || "dark";
    } catch {
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
        ${page.child_count ? `<span class="nav-count">${page.child_count}</span>` : ""}
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
      $("compose-btn").classList.toggle("hidden", !isPage || !isMd);
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
        let t = n.text || "";
        if (n.marks) {
          n.marks.forEach((m) => {
            if (m.type === "bold") t = `**${t}**`;
            else if (m.type === "italic") t = `*${t}*`;
            else if (m.type === "strike") t = `~~${t}~~`;
            else if (m.type === "code") t = `\`${t}\``;
            else if (m.type === "link") t = `[${t}](${m.attrs?.href || ""})`;
          });
        }
        return t;
      }).join("");
    }
    function block(node, indent) {
      indent = indent || "";
      const t = node.type;
      const c = node.content || [];
      if (t === "doc") return c.map((n) => block(n, "")).join("\n");
      if (t === "paragraph") return indent + (inline(c) || "") + "\n";
      if (t === "heading") return "#".repeat(node.attrs?.level) + " " + inline(c) + "\n";
      if (t === "horizontalRule") return "---\n";
      if (t === "codeBlock") {
        const lang = node.attrs?.language || "";
        const code = c.map((n) => n.text || "").join("");
        return `\`\`\`${lang}
${code}
\`\`\`
`;
      }
      if (t === "blockquote") return c.map((n) => "> " + block(n, "").trimEnd()).join("\n") + "\n";
      if (t === "bulletList") return c.map((n) => block(n, "- ")).join("");
      if (t === "orderedList") {
        let i = node.attrs?.start || 1;
        return c.map((n) => block(n, `${i++}. `)).join("");
      }
      if (t === "taskList") {
        return c.map((n) => {
          const checked = n.attrs?.checked;
          const checkbox = checked ? "[x]" : "[ ]";
          const content = (n.content || []).map((n2) => block(n2, "")).join("").trimEnd();
          return `- ${checkbox} ${content}
`;
        }).join("");
      }
      if (t === "listItem" || t === "taskItem") {
        const content = c.map((n) => block(n, "")).join("").trimEnd();
        return indent + content + "\n";
      }
      if (t === "hardBreak") return "  \n";
      if (t === "text") return node.text || "";
      return c.map((n) => block(n, indent)).join("");
    }
    try {
      return block(doc, "").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
    } catch {
      return "";
    }
  }
  function renderWysiwygEditor(page, container) {
    container.className = "content-area wysiwyg-wrap fade-in";
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
    const { Editor, Extension, InputRule, StarterKit, TaskList, TaskItem, Placeholder } = window.TipTapBundle;
    const TaskBracketRule = Extension.create({
      name: "taskBracketRule",
      addInputRules() {
        return [
          new InputRule({
            find: /^\[\]\s$/,
            handler: ({ chain, range }) => {
              chain().deleteRange(range).toggleTaskList().run();
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
        Placeholder.configure({
          placeholder: "Start writing\u2026 Use # for headings, [] for tasks, - for lists"
        })
      ],
      content: initialHtml,
      autofocus: true,
      editorProps: {
        attributes: { class: "tiptap-content", spellcheck: "true" }
      },
      onUpdate({ editor: editor2 }) {
        const md = tiptapToMarkdown(editor2.getJSON());
        debounceSave(md);
        if (state.currentPage) state.currentPage.content = md;
      }
    });
    state.wysiwyg = editor;
    $("wysiwyg-editor").addEventListener("keydown", (e) => {
      const ke = e;
      if ((ke.metaKey || ke.ctrlKey) && ke.key === "s") {
        ke.preventDefault();
        savePage(tiptapToMarkdown(editor.getJSON()));
      }
    }, true);
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
        <div class="folder-actions" style="margin-bottom:12px;">
          <button class="btn btn-sm btn-ghost" onclick="openNewPageModal('page','${page.id}')">\u{1F4DD} Add Page</button>
          <button class="btn btn-sm btn-ghost" onclick="openNewPageModal('folder','${page.id}')">\u{1F4C1} Add Folder</button>
          <button class="btn btn-sm btn-ghost" onclick="openNewPageModal('image')">\u{1F5BC}\uFE0F Add Image</button>
        </div>
        <div class="folder-num">SECTION ${sectionNum}</div>
        <h1 class="folder-title" style="margin:0">${esc(displayName)}</h1>
        <p class="folder-meta">${children.length} item${children.length !== 1 ? "s" : ""}</p>
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
                <div class="child-card-meta">${child.type === "folder" ? `${child.child_count || 0} items` : ext.toUpperCase() || "MD"}</div>
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
            <div class="asset-card">
              <div class="asset-preview">
                <img src="${api.assetUrl(a.id)}" alt="${esc(a.original_name)}" loading="lazy">
                <div class="asset-overlay">
                  <button class="asset-overlay-btn" onclick="openLightbox('${api.assetUrl(a.id)}','${esc(a.original_name)}')" title="View">\u{1F441}</button>
                  <button class="asset-overlay-btn" onclick="copyToClipboard('${api.assetUrl(a.id)}')" title="Copy URL">\u{1F4CB}</button>
                  <button class="asset-overlay-btn" onclick="deleteAsset('${a.id}')" title="Delete" style="color:var(--danger)">\u{1F5D1}</button>
                </div>
              </div>
              <div class="asset-info">
                <div class="asset-name">${esc(a.original_name)}</div>
                <div class="asset-type">${(a.size / 1024).toFixed(1)} KB</div>
              </div>
            </div>
          `).join("")}
        </div>
      ` : ""}
      ${files.length ? `
        <div class="section-heading" style="margin-top:${imgs.length ? "24px" : 0}">Files \xB7 ${files.length}</div>
        ${files.map((a) => {
      const ext = a.original_name.split(".").pop()?.toUpperCase() || "";
      return `
            <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:var(--radius);padding:12px 16px;display:flex;align-items:center;gap:12px;margin-bottom:7px;">
              <div style="font-size:24px;flex-shrink:0">\u{1F4C4}</div>
              <div style="flex:1;min-width:0">
                <div style="font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.original_name)}</div>
                <div style="font-family:'IBM Plex Mono',monospace;font-size:11px;color:var(--text-dim)">${ext} \xB7 ${(a.size / 1024).toFixed(1)} KB</div>
              </div>
              <div style="display:flex;gap:6px">
                <a href="${api.assetUrl(a.id)}" download="${esc(a.original_name)}" class="btn btn-ghost btn-sm">\u2193 Download</a>
                <button class="btn btn-danger btn-sm" onclick="deleteAsset('${a.id}')">Delete</button>
              </div>
            </div>
          `;
    }).join("")}
      ` : ""}
    </div>
  `;
  }
  function renderUploadZone(pageId) {
    return `
    <div class="assets-section">
      <div class="section-heading">Upload Files</div>
      <div class="upload-zone" id="upload-zone-${pageId}" onclick="triggerUpload('${pageId}')">
        <div class="upload-zone-icon">\u{1F4CE}</div>
        <div class="upload-zone-text">Drop files here or click to upload</div>
        <div class="upload-zone-hint">Images, PDFs, videos \u2014 up to 50 MB</div>
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
    showToast(`Uploading ${files.length} file(s)\u2026`);
    const form = new FormData();
    for (const f of Array.from(files)) form.append("files", f);
    form.append("page_id", pageId);
    try {
      await api.uploadFiles(form);
      showToast("Uploaded!");
      await renderPage(pageId);
    } catch (err) {
      showToast("Upload failed: " + err.message, "error");
    }
  }
  var _confirmDeleteResolve = null;
  function showConfirmDelete(filename) {
    return new Promise((resolve) => {
      _confirmDeleteResolve = resolve;
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
    $("new-page-ai-prefill-row").style.display = isImage ? "none" : "";
    $("new-page-ai-section").style.display = "none";
    $("new-page-image-section").style.display = isImage ? "" : "none";
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
    const isHidden = section.style.display === "none" || !section.style.display;
    section.style.display = isHidden ? "" : "none";
    if (isHidden) $("new-page-ai-prompt").focus();
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
      try {
        showToast("Generating image\u2026 \u23F3");
        const page_id = state.currentPageId ?? void 0;
        await api.generateImg({ prompt: imagePrompt, page_id });
        closeNewPageModal();
        if (state.currentPageId) await renderPage(state.currentPageId);
        showToast("Image generated!");
      } catch (err) {
        showToast("Failed: " + err.message, "error");
      } finally {
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
        showToast("Generating content with AI\u2026 \u23F3");
        const { content: gen } = await api.generate({ prompt: aiPrompt, type: fileType });
        content = gen;
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
    $("topbar-badge").textContent = "";
    $("page-title").value = "";
    $("bc-parent").textContent = "yo\u0131nko";
    $("compose-btn").classList.add("hidden");
    $("edit-toggle-btn").classList.add("hidden");
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
    try {
      await api.updatePage(_renameId, { name: newName });
      await loadPages();
      if (state.currentPageId === _renameId && state.currentPage) {
        state.currentPage.display_name = newName;
        $("page-title").value = newName;
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
  async function submitDelete() {
    $("delete-overlay").classList.remove("open");
    try {
      await api.deletePage(_deleteId);
      await loadPages();
      if (state.currentPageId === _deleteId) showWelcome();
      showToast("Deleted.");
    } catch (err) {
      showToast("Delete failed: " + err.message, "error");
    }
  }
  var ctxMenu = document.createElement("div");
  ctxMenu.className = "ctx-menu";
  ctxMenu.id = "ctx-menu";
  document.body.appendChild(ctxMenu);
  function showCtxMenu(e, page) {
    e.preventDefault();
    const displayName = page.display_name || page.name;
    ctxMenu.innerHTML = `
    <div class="ctx-menu-item" onclick="renamePagePrompt('${page.id}','${esc(displayName)}')">\u270F\uFE0F Rename</div>
    ${page.type === "folder" ? `
      <div class="ctx-menu-item" onclick="openNewPageModal('page','${page.id}')">\u{1F4C4} Add Page Inside</div>
      <div class="ctx-menu-item" onclick="openNewPageModal('folder','${page.id}')">\u{1F4C1} Add Folder Inside</div>
    ` : ""}
    <div class="ctx-menu-sep"></div>
    <div class="ctx-menu-item danger" onclick="deletePageConfirm('${page.id}','${esc(displayName)}')">\u{1F5D1} Delete</div>
  `;
    ctxMenu.style.left = `${Math.min(e.clientX, window.innerWidth - 180)}px`;
    ctxMenu.style.top = `${Math.min(e.clientY, window.innerHeight - 120)}px`;
    ctxMenu.classList.add("open");
  }
  document.addEventListener("click", () => ctxMenu.classList.remove("open"));
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
  function openCompose() {
    $("compose-popup").classList.toggle("open");
    $("compose-input").focus();
  }
  async function submitCompose() {
    const prompt = $("compose-input").value.trim();
    if (!prompt || !state.currentPage) return;
    const btn = $("compose-submit");
    btn.disabled = true;
    btn.textContent = "Generating\u2026";
    try {
      const { content: newSection } = await api.generate({
        prompt,
        type: state.currentPage.file_type || "md",
        context: (state.currentPage.content || "").slice(0, 1500)
      });
      const sep = state.currentPage.file_type === "html" ? "\n\n<!-- section -->\n" : "\n\n---\n\n";
      const newContent = (state.currentPage.content || "") + sep + newSection;
      await api.updatePage(state.currentPageId, { content: newContent });
      state.currentPage.content = newContent;
      $("compose-popup").classList.remove("open");
      $("compose-input").value = "";
      await renderPage(state.currentPageId);
      showToast("Section added!");
    } catch (err) {
      showToast("AI failed: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "\u2728 Generate";
    }
  }
  function toggleChat() {
    state.chatOpen = !state.chatOpen;
    $("chat-drawer").classList.toggle("open", state.chatOpen);
    if (state.chatOpen && state.currentPageId) loadChatHistory();
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
      container.innerHTML = `<div style="text-align:center;padding:32px 0;color:var(--text-dim);font-size:13px;"><div style="font-size:32px;margin-bottom:8px">\u{1F916}</div>Ask me anything about this page, or request edits!</div>`;
      return;
    }
    container.innerHTML = state.chatMessages.map((m) => `
    <div class="chat-msg ${m.role}">
      <div class="chat-msg-role">${m.role === "user" ? "You" : "AI"}</div>
      <div class="chat-msg-content">${m.role === "assistant" ? renderMarkdownSimple(m.content) : esc(m.content)}</div>
    </div>
  `).join("");
    container.scrollTop = container.scrollHeight;
  }
  function renderMarkdownSimple(text) {
    return text.replace(/```[\s\S]*?```/g, (m) => `<pre style="background:var(--surface-3);padding:8px;border-radius:6px;font-size:12px;overflow-x:auto;margin:6px 0"><code>${esc(m.slice(3, -3).replace(/^[^\n]*\n/, ""))}</code></pre>`).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\*(.+?)\*/g, "<em>$1</em>").replace(/\n/g, "<br>");
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
      <div class="chat-msg-role">AI</div>
      <div class="chat-typing"><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div></div>
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
  async function openSettings() {
    $("settings-overlay").classList.add("open");
    try {
      const { settings } = await api.getSettings();
      state.settings = settings;
      $("settings-provider").value = settings.llm_provider || "openai";
      $("settings-model").value = settings.llm_model || "";
      $("settings-api-key").value = "";
      $("settings-api-key").placeholder = settings.llm_api_key_masked || "Enter API key\u2026";
      $("settings-base-url").value = settings.llm_base_url || "";
      const knownModels = ["dall-e-3", "dall-e-2", "imagen-3"];
      const savedModel = settings.image_model || "dall-e-3";
      const isCustom = !knownModels.includes(savedModel);
      const selectEl = $("settings-image-model");
      selectEl.value = isCustom ? "__custom__" : savedModel;
      toggleCustomImageModel(selectEl.value);
      if (isCustom) {
        $("settings-image-model-custom").value = savedModel;
      }
      updateProviderCards(settings.llm_provider || "openai");
      updateProviderUI(settings.llm_provider || "openai");
      updateActiveProviderLabel(settings.llm_provider || "openai");
    } catch {
      showToast("Failed to load settings", "error");
    }
  }
  function closeSettings() {
    $("settings-overlay").classList.remove("open");
  }
  function selectProvider(p) {
    $("settings-provider").value = p;
    updateProviderCards(p);
    updateProviderUI(p);
    updateActiveProviderLabel(p);
    const defaults = {
      openai: "gpt-4o-mini",
      gemini: "gemini-2.0-flash",
      claude: "claude-3-5-haiku-20241022",
      "openai-compatible": ""
    };
    const modelEl = $("settings-model");
    if (!modelEl.value) modelEl.value = defaults[p] || "";
  }
  function updateProviderCards(p) {
    $$(".provider-card").forEach((c) => c.classList.toggle("selected", c.dataset.provider === p));
  }
  function updateProviderUI(p) {
    $("base-url-row").style.display = p === "openai-compatible" ? "" : "none";
  }
  function updateActiveProviderLabel(p) {
    const labels = {
      openai: "OpenAI",
      gemini: "Google Gemini",
      claude: "Anthropic Claude",
      "openai-compatible": "OpenAI Compatible"
    };
    const el = $("active-provider-label");
    if (el) el.textContent = labels[p] || p;
  }
  async function saveSettings() {
    const selectVal = $("settings-image-model").value;
    const imageModel = selectVal === "__custom__" ? $("settings-image-model-custom").value.trim() || "dall-e-3" : selectVal;
    const updates = {
      llm_provider: $("settings-provider").value,
      llm_model: $("settings-model").value,
      llm_base_url: $("settings-base-url").value,
      image_model: imageModel
    };
    const key = $("settings-api-key").value;
    if (key) updates.llm_api_key = key;
    try {
      await api.saveSettings(updates);
      closeSettings();
      showToast("Settings saved!");
    } catch (err) {
      showToast("Save failed: " + err.message, "error");
    }
  }
  function toggleCustomImageModel(val) {
    $("custom-image-model-row").style.display = val === "__custom__" ? "" : "none";
    if (val === "__custom__") {
      setTimeout(() => $("settings-image-model-custom").focus(), 50);
    }
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
    const result = marked.parse(text || "", { async: false });
    const html = typeof result === "string" ? result : `<pre>${esc(text || "")}</pre>`;
    return html.replace(
      /<ul>\s*(<li>\s*<input[^>]*type="checkbox"[^>]*>[\s\S]*?<\/li>\s*)<\/ul>/g,
      (_, items) => {
        const converted = items.replace(
          /<li>\s*<input([^>]*)type="checkbox"([^>]*)>([\s\S]*?)<\/li>/g,
          (_m, pre, post, content) => {
            const checked = (pre + post).includes("checked") ? 'data-checked="true"' : 'data-checked="false"';
            return `<li data-type="taskItem" ${checked}><label><input type="checkbox" ${(pre + post).includes("checked") ? "checked" : ""}><span>${content.trim()}</span></label></li>`;
          }
        );
        return `<ul data-type="taskList">${converted}</ul>`;
      }
    );
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
    $("compose-btn").addEventListener("click", openCompose);
    $("compose-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submitCompose();
      if (e.key === "Escape") $("compose-popup").classList.remove("open");
    });
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".compose-popup") && !e.target.closest("#compose-btn")) {
        $("compose-popup").classList.remove("open");
      }
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
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeLightbox();
        closeConfirmDelete(false);
        $("compose-popup").classList.remove("open");
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
