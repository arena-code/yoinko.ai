// src/client/app.ts — Main application logic (filesystem-backed)
import { Sentry } from './sentry.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MarkerType,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node as FlowNode,
  type NodeChange,
  type NodeMouseHandler,
  type NodeProps,
  type OnSelectionChangeParams,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {
  Kanban,
  dropColumnHandler,
  dropHandler,
  type BoardData,
  type BoardItem,
} from 'react-kanban-kit';
import jspreadsheet from 'jspreadsheet-ce';
import 'jspreadsheet-ce/dist/jspreadsheet.css';
import 'jsuites/dist/jsuites.css';
import { api, getCurrentProjectId, setCurrentProjectId } from './api.js';
import { canCreateFolderInParent, canMovePageToParent } from '../shared/page-depth.js';
import type { PageNode, Asset, Settings, LLMMessage, Project, LLMProfile, MdTemplate, PriorityTodo, Priority, TeamMember, PageShareInfo } from '../shared/types.js';

// ── TipTap editor instance type ───────────────────────────────────────────────
interface TipTapChain {
  focus: () => TipTapChain;
  toggleBold: () => TipTapChain;
  toggleItalic: () => TipTapChain;
  toggleUnderline: () => TipTapChain;
  toggleStrike: () => TipTapChain;
  toggleCode: () => TipTapChain;
  toggleBlockquote: () => TipTapChain;
  toggleCodeBlock: () => TipTapChain;
  toggleBulletList: () => TipTapChain;
  toggleOrderedList: () => TipTapChain;
  toggleTaskList: () => TipTapChain;
  toggleHeading: (opts: { level: number }) => TipTapChain;
  setHorizontalRule: () => TipTapChain;
  setLink: (attrs: { href: string; target?: string }) => TipTapChain;
  unsetLink: () => TipTapChain;
  undo: () => TipTapChain;
  redo: () => TipTapChain;
  run: () => void;
}

interface TipTapEditor {
  getJSON: () => TipTapDoc;
  destroy: () => void;
  chain: () => TipTapChain;
  isActive: (name: string, attrs?: Record<string, unknown>) => boolean;
  on: (event: string, cb: (props: { editor: TipTapEditor }) => void) => void;
  off: (event: string, cb: unknown) => void;
  can: () => TipTapChain & { run: () => boolean };
}

// ── TipTap bundle type declaration ────────────────────────────────────────────
interface TipTapBundle {
  Editor: new (opts: Record<string, unknown>) => TipTapEditor;
  Extension: { create: (opts: Record<string, unknown>) => unknown };
  InputRule: new (opts: Record<string, unknown>) => unknown;
  StarterKit: unknown;
  TaskList: unknown;
  TaskItem: { configure: (opts: Record<string, unknown>) => unknown };
  Placeholder: { configure: (opts: Record<string, unknown>) => unknown };
  Table: { configure: (opts: Record<string, unknown>) => unknown };
  TableRow: unknown;
  TableCell: unknown;
  TableHeader: unknown;
  Underline: unknown;
  Link: { configure: (opts: Record<string, unknown>) => unknown };
  ListKeymap: unknown;
}

interface TipTapDoc {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapDoc[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
}

type LegacyDiagramShape = { id: string; type: 'box' | 'note'; x: number; y: number; text: string; color: string };
type DiagramNodeKind = 'box' | 'note' | 'text';
type DiagramNodeData = { label: string; color?: string; kind?: DiagramNodeKind };
type DiagramNode = FlowNode<DiagramNodeData, 'yoinko'>;
type DiagramEdge = Edge<Record<string, unknown>>;
type DiagramDoc = { nodes: DiagramNode[]; edges: DiagramEdge[] };
type KanbanStatus = string;
type KanbanColumn = { id: KanbanStatus; title: string };
type KanbanTask = { id: string; title: string; status: KanbanStatus; priority?: Priority; assignee_id?: string; assignee_email?: string };
type KanbanDoc = { tasks: KanbanTask[]; columns?: KanbanColumn[] };
type KanbanCardContent = { priority?: Priority; assignee_id?: string; assignee_email?: string };
type SheetColumnDoc = { title?: string; width?: string | number };
type SheetWorksheetDoc = { name?: string; cells?: string[][]; style?: Record<string, string>; columns?: SheetColumnDoc[] };
type SheetDoc = { cells?: string[][]; worksheets?: SheetWorksheetDoc[] };
type SheetCellValue = jspreadsheet.CellValue;
type SheetWorksheet = jspreadsheet.WorksheetInstance;
type SheetSpreadsheet = jspreadsheet.SpreadsheetInstance;
type SheetToolbarItem = jspreadsheet.ToolbarItem;
type SheetContextMenuItem = jspreadsheet.ContextMenuItem;
type SheetContextMenuRole = jspreadsheet.ContextMenuRole;
type SheetToolbarConfig = { items?: SheetToolbarItem[]; [key: string]: unknown };
type ReactFlowProps = {
  initialDoc: DiagramDoc;
  locked: boolean;
  onSave: (doc: DiagramDoc) => Promise<void>;
};
type KanbanReactProps = {
  initialDoc: KanbanDoc;
  locked: boolean;
  assignableMembers: TeamMember[];
  assignmentsEnabled: boolean;
  membersLoading: boolean;
  onSave: (doc: KanbanDoc) => Promise<void>;
};
type KanbanKitConfigMap = Record<string, {
  render: (props: { data: BoardItem; column: BoardItem; index: number; isDraggable: boolean }) => React.ReactNode;
  isDraggable?: boolean;
}>;
type KanbanKitDropCardParams = {
  cardId: string;
  fromColumnId: string;
  toColumnId: string;
  taskAbove: string | null;
  taskBelow: string | null;
  position?: number;
};
type KanbanKitDropColumnParams = {
  columnId: string;
  fromIndex: number;
  toIndex: number;
};

function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function parseJson<T>(content: string | undefined, fallback: T): T {
  if (!content?.trim()) return fallback;
  try { return JSON.parse(content) as T; } catch { return fallback; }
}

function createDiagramNode(label: string, position: { x: number; y: number }, color = '#fff3bf', kind: DiagramNodeKind = 'box'): DiagramNode {
  return {
    id: uid('node'),
    type: 'yoinko',
    position,
    data: { label, color, kind },
  };
}

function withDiagramNodeStyle(node: DiagramNode): DiagramNode {
  const kind = node.data?.kind || 'box';
  const color = node.data?.color || (kind === 'text' ? 'transparent' : '#fff3bf');
  const { style: _legacyStyle, className: _legacyClassName, ...nodeWithoutLegacyWrapperStyles } = node;
  return {
    ...nodeWithoutLegacyWrapperStyles,
    type: 'yoinko',
    data: {
      label: String(node.data?.label || 'Untitled'),
      color,
      kind,
    },
  };
}

function normalizeDiagramDoc(content: string | undefined): DiagramDoc {
  const raw = parseJson<Partial<DiagramDoc> & { shapes?: LegacyDiagramShape[] }>(content, {});
  if (Array.isArray(raw.nodes)) {
    return {
      nodes: raw.nodes.map(node => withDiagramNodeStyle(node as DiagramNode)),
      edges: Array.isArray(raw.edges) ? raw.edges.map(edge => ({
        ...edge,
        markerEnd: edge.markerEnd || { type: MarkerType.ArrowClosed },
      } as DiagramEdge)) : [],
    };
  }
  if (Array.isArray(raw.shapes)) {
    return {
      nodes: raw.shapes.map(shape => createDiagramNode(shape.text || 'Untitled', { x: Number(shape.x) || 0, y: Number(shape.y) || 0 }, shape.color || '#fff3bf', shape.type)),
      edges: [],
    };
  }
  return { nodes: [], edges: [] };
}

const DEFAULT_KANBAN_COLUMNS: KanbanColumn[] = [
  { id: 'todo', title: 'To do' },
  { id: 'doing', title: 'Doing' },
  { id: 'done', title: 'Done' },
];

function kanbanColumnsForDoc(doc: KanbanDoc): KanbanColumn[] {
  const columns = Array.isArray(doc.columns) && doc.columns.length
    ? [...doc.columns]
    : [...DEFAULT_KANBAN_COLUMNS];
  for (const task of doc.tasks) {
    if (!columns.some(col => col.id === task.status)) {
      columns.push({ id: task.status, title: task.status });
    }
  }
  return columns;
}

function kanbanDocToBoardData(doc: KanbanDoc): BoardData {
  const columns = kanbanColumnsForDoc(doc);
  const dataSource: BoardData = {
    root: {
      id: 'root',
      title: 'Root',
      parentId: null,
      children: columns.map(col => col.id),
      totalChildrenCount: columns.length,
    },
  };
  for (const col of columns) {
    const children = doc.tasks.filter(task => task.status === col.id).map(task => task.id);
    dataSource[col.id] = {
      id: col.id,
      title: col.title,
      parentId: 'root',
      children,
      totalChildrenCount: children.length,
      isDraggable: true,
    };
  }
  for (const task of doc.tasks) {
    dataSource[task.id] = {
      id: task.id,
      title: task.title || 'Untitled task',
      parentId: task.status,
      children: [],
      totalChildrenCount: 0,
      type: 'card',
      content: {
        priority: task.priority || 'medium',
        assignee_id: task.assignee_id,
        assignee_email: task.assignee_email,
      } satisfies KanbanCardContent,
    };
  }
  return dataSource;
}

function boardDataToKanbanDoc(dataSource: BoardData): KanbanDoc {
  const columns = (dataSource.root?.children || [])
    .map(columnId => dataSource[columnId])
    .filter((column): column is BoardItem => !!column)
    .map(column => ({ id: column.id, title: column.title }));
  const tasks: KanbanTask[] = [];
  for (const col of columns) {
    const column = dataSource[col.id];
    for (const taskId of column?.children || []) {
      const task = dataSource[taskId];
      if (!task) continue;
      const content = (task.content || {}) as KanbanCardContent;
      tasks.push({
        id: task.id,
        title: task.title || 'Untitled task',
        status: task.parentId || column.id,
        priority: content.priority || 'medium',
        assignee_id: content.assignee_id || undefined,
        assignee_email: content.assignee_email || undefined,
      });
    }
  }
  return { columns, tasks };
}

function normalizeKanbanBoardData(dataSource: BoardData): BoardData {
  const next: BoardData = { ...dataSource };
  for (const columnId of next.root?.children || []) {
    const column = next[columnId];
    if (!column) continue;
    const children = column.children || [];
    next[columnId] = { ...column, children, totalChildrenCount: children.length };
    for (const taskId of children) {
      const task = next[taskId];
      if (task) next[taskId] = { ...task, parentId: columnId };
    }
  }
  return next;
}

function defaultContentForFileType(fileType: string): string {
  if (fileType === 'diagram') {
    return JSON.stringify({
      nodes: [
        createDiagramNode('Start', { x: 80, y: 100 }, '#fff3bf', 'note'),
        createDiagramNode('Next step', { x: 360, y: 100 }, '#d0ebff', 'box'),
      ],
      edges: [],
    } satisfies DiagramDoc, null, 2);
  }
  if (fileType === 'kanban') {
    return JSON.stringify({ tasks: [] } satisfies KanbanDoc, null, 2);
  }
  if (fileType === 'sheet') {
    return JSON.stringify({
      cells: [
        ['Name', 'Status', 'Notes'],
        ['', '', ''],
        ['', '', ''],
      ],
      worksheets: [{
        name: 'Sheet 1',
        cells: [
          ['Name', 'Status', 'Notes'],
          ['', '', ''],
          ['', '', ''],
        ],
      }],
    } satisfies SheetDoc, null, 2);
  }
  return '';
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
    openAssetCardMenu: (id: string, ev: MouseEvent) => void;
    openChildCardMenu: (id: string, ev: MouseEvent) => void;
    closeCardMenu: () => void;
    closeMoveModal: () => void;
    submitMove: () => void;
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
    openSettingsTab: (tab: 'ai' | 'templates') => void;
    openNewTemplateForm: () => void;
    editTemplate: (id: string) => void;
    deleteTemplateById: (id: string) => void;
    cancelTemplateEdit: () => void;
    saveCurrentTemplate: () => void;

    toggleHtmlEditMode: () => void;
    triggerUpload: (pageId: string) => void;
    handleFileUpload: (e: Event, pageId: string) => void;
    clearChat: () => void;
    applyAiSuggestion: () => void;
    closeLightbox: () => void;
    sendChatMessage: () => void;
    changeChatProfile: (id: string) => void;
    toggleChat: () => void;
    toggleSidebar: () => void;
    switchProject: (id: string) => void;
    openCreateProjectModal: () => void;
    closeCreateProjectModal: () => void;
    submitCreateProject: () => void;
    deleteProjectConfirm: (id: string, name: string) => void;
    closeConfirmDeleteProject: (result: boolean) => void;
    openRenameProjectModal: (id: string, name: string) => void;
    triggerProjectLogoUpload: () => void;
    handleProjectLogoUpload: (e: Event) => void;
    removeProjectLogo: () => void;
    closeRenameProjectModal: () => void;
    submitRenameProject: () => void;
    toggleProjectMenu: () => void;
    cloudLogout: () => void;
    openWorkspaceMembersModal: (id: string, name: string) => void;
    closeWorkspaceMembersModal: () => void;
    revokeWorkspaceMember: (userId: string) => void;
    submitGrantWorkspaceAccess: () => void;
    toggleWmPicker: () => void;
    onWmPickerChange: () => void;
    openCodeFileEditor: (id: string, name: string, url: string) => void;
    closeCodeFileEditor: () => void;
    saveCodeFile: () => void;
    togglePageLock: () => void;
    openPageShareModal: () => void;
    openAssetShareModal: (id: string) => void;
    closePageShareModal: () => void;
    publishCurrentPage: () => void;
    unpublishCurrentPage: () => void;
    copyCurrentShareLink: () => void;
    syncSharePasswordUI: () => void;
    addPriorityTodoBoard: () => void;
    addPriorityTodo: (priority: Priority) => void;
    editPriorityTodo: (id: string) => void;
    togglePriorityTodo: (id: string) => void;
    deletePriorityTodo: (id: string) => void;
    addSheetRow: () => void;
    addSheetColumn: () => void;
    switchTab: (tabId: string) => void;
    closeTab: (tabId: string) => void;
    openNewTab: () => void;
    addNewProfile: () => void;
    deleteCurrentProfile: () => void;
    confirmDeleteProfile: () => void;
    setActiveCurrentProfile: () => void;
    saveCurrentProfile: () => void;
    selectProfileItem: (id: string) => void;
  }

  // Marked declared as global from CDN script tag
  const marked: { parse: (text: string, opts?: { async?: boolean; gfm?: boolean; breaks?: boolean }) => string | Promise<string>; use: (opts: object) => void; };
}

// ── State ─────────────────────────────────────────────────────────────────────
interface NavPageNode extends PageNode {
  _children: NavPageNode[];
}

function sidebarNavName(page: NavPageNode): string {
  return page.display_name || page.name || '';
}

function compareSidebarNavNodes(a: NavPageNode, b: NavPageNode): number {
  if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
  return sidebarNavName(a).localeCompare(sidebarNavName(b), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

interface AppTab {
  id: string;
  pageId: string;
  name: string;
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
  wysiwyg: TipTapEditor | null;
  previewMode?: boolean;
  editMode?: boolean;
  aiEnabled: boolean;
  openTabs: AppTab[];
  activeTabId: string | null;
  isCloud: boolean;
  isOwner: boolean;
  userPlan: string;
  currentUser: TeamMember | null;
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
  aiEnabled: false,
  openTabs: [],
  activeTabId: null,
  isCloud: false,
  isOwner: true,
  userPlan: 'basic',
  currentUser: null,
};

let diagramRoot: Root | null = null;
let kanbanRoot: Root | null = null;
let sheetHost: HTMLDivElement | null = null;
let sheetWorksheet: SheetWorksheet | null = null;
let sheetSpreadsheet: SheetSpreadsheet | null = null;
let sheetPageId: string | null = null;
let sheetSaveTimer: ReturnType<typeof setTimeout> | undefined;
let sheetEventsReady = false;
let kanbanAssignableMembers: TeamMember[] = [];
let kanbanAssignableMembersLoaded = false;
let kanbanAssignableMembersPromise: Promise<TeamMember[]> | null = null;
let currentShareInfo: PageShareInfo | null = null;
type ShareTarget = { kind: 'page'; id: string; label: string } | { kind: 'asset'; id: string; label: string; assetType: 'image' | 'document' | 'file' };
let currentShareTarget: ShareTarget | null = null;

function isCloudPlusPlan(): boolean {
  const plan = state.userPlan.toLowerCase();
  return state.isCloud && (plan === 'cloud_plus' || plan.includes('plus') || plan.includes('pro'));
}

function withCurrentUserMember(members: TeamMember[]): TeamMember[] {
  const merged: TeamMember[] = [];
  const seen = new Set<string>();
  const add = (member: TeamMember | null | undefined) => {
    if (!member?.user_id || !member.email || seen.has(member.user_id)) return;
    seen.add(member.user_id);
    merged.push(member);
  };

  add(state.currentUser);
  members.forEach(add);
  return merged;
}

async function loadKanbanAssignableMembers(): Promise<TeamMember[]> {
  if (!isCloudPlusPlan()) return [];
  if (kanbanAssignableMembersLoaded) return kanbanAssignableMembers;
  if (kanbanAssignableMembersPromise) return kanbanAssignableMembersPromise;

  kanbanAssignableMembersPromise = api.getTeamMembers()
    .then(({ members }) => {
      kanbanAssignableMembers = withCurrentUserMember(members);
      kanbanAssignableMembersLoaded = true;
      return kanbanAssignableMembers;
    })
    .catch(() => {
      kanbanAssignableMembersLoaded = true;
      kanbanAssignableMembers = withCurrentUserMember([]);
      return kanbanAssignableMembers;
    })
    .finally(() => {
      kanbanAssignableMembersPromise = null;
    });

  return kanbanAssignableMembersPromise;
}

function disposeDiagramRoot(): void {
  if (!diagramRoot) return;
  try { diagramRoot.unmount(); } catch { /* already unmounted */ }
  diagramRoot = null;
}

function disposeKanbanRoot(): void {
  if (!kanbanRoot) return;
  try { kanbanRoot.unmount(); } catch { /* already unmounted */ }
  kanbanRoot = null;
}

function disposeSheetGrid(): void {
  if (sheetSaveTimer) {
    clearTimeout(sheetSaveTimer);
    sheetSaveTimer = undefined;
    if (sheetWorksheet && sheetPageId) {
      void saveSheetFromInstance(sheetPageId, sheetWorksheet);
    }
  }

  if (sheetHost) {
    try { jspreadsheet.destroy(sheetHost as Parameters<typeof jspreadsheet.destroy>[0], true); } catch { sheetHost.innerHTML = ''; }
  }
  sheetHost = null;
  sheetWorksheet = null;
  sheetSpreadsheet = null;
  sheetPageId = null;
  sheetEventsReady = false;
}

function disposeReactToolRoots(): void {
  disposeDiagramRoot();
  disposeKanbanRoot();
  disposeSheetGrid();
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement;
const $$ = (sel: string): NodeListOf<HTMLElement> => document.querySelectorAll(sel);
const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function showMascotLoading(text = 'Working on it…', sub = 'Yoyo is thinking'): void {
  $('mascot-loading-text').textContent = text;
  $('mascot-loading-sub').textContent = sub;
  $('mascot-loading').classList.add('active');
}

function hideMascotLoading(): void {
  $('mascot-loading').classList.remove('active');
}

function withSentryErrorBoundary(child: React.ReactElement, fallbackText: string): React.ReactElement {
  return React.createElement(
    Sentry.ErrorBoundary,
    { fallback: React.createElement('p', { className: 'tool-error-fallback' }, fallbackText) },
    child,
  );
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init(): Promise<void> {
  // Register all inline-onclick globals FIRST so they're available regardless of
  // whether loadPages / setupEventListeners throws later.
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
  window.openSettingsTab = openSettingsTab;
  window.openNewTemplateForm = openNewTemplateForm;
  window.editTemplate = editTemplate;
  window.deleteTemplateById = deleteTemplateById;
  window.cancelTemplateEdit = cancelTemplateEdit;
  window.saveCurrentTemplate = saveCurrentTemplate;

  window.toggleHtmlEditMode = toggleHtmlEditMode;
  window.openCodeFileEditor = openCodeFileEditor;
  window.closeCodeFileEditor = closeCodeFileEditor;
  window.saveCodeFile = saveCodeFile;
  window.togglePageLock = togglePageLock;
  window.openPageShareModal = openPageShareModal;
  window.openAssetShareModal = openAssetShareModal;
  window.closePageShareModal = closePageShareModal;
  window.publishCurrentPage = publishCurrentPage;
  window.unpublishCurrentPage = unpublishCurrentPage;
  window.copyCurrentShareLink = copyCurrentShareLink;
  window.syncSharePasswordUI = syncSharePasswordUI;
  window.addPriorityTodoBoard = addPriorityTodoBoard;
  window.addPriorityTodo = addPriorityTodo;
  window.editPriorityTodo = editPriorityTodo;
  window.togglePriorityTodo = togglePriorityTodo;
  window.deletePriorityTodo = deletePriorityTodo;
  window.addSheetRow = addSheetRow;
  window.addSheetColumn = addSheetColumn;
  window.switchTab = switchTab;
  window.closeTab = closeTab;
  window.openNewTab = openNewTab;
  window.triggerUpload = triggerUpload;
  window.handleFileUpload = handleFileUpload;
  window.clearChat = clearChat;
  window.applyAiSuggestion = applyAiSuggestion;
  window.closeLightbox = closeLightbox;
  window.sendChatMessage = sendChatMessage;
  window.changeChatProfile = changeChatProfile;
  window.toggleChat = toggleChat;
  window.toggleSidebar = toggleSidebar;
  window.switchProject = switchProject;
  window.openCreateProjectModal = openCreateProjectModal;
  window.closeCreateProjectModal = closeCreateProjectModal;
  window.submitCreateProject = submitCreateProject;
  window.deleteProjectConfirm = deleteProjectConfirm;
  window.closeConfirmDeleteProject = closeConfirmDeleteProject;
  window.openRenameProjectModal = openRenameProjectModal;
  window.triggerProjectLogoUpload = triggerProjectLogoUpload;
  window.handleProjectLogoUpload = handleProjectLogoUpload;
  window.removeProjectLogo = removeProjectLogo;
  window.closeRenameProjectModal = closeRenameProjectModal;
  window.submitRenameProject = submitRenameProject;
  window.openWorkspaceMembersModal = openWorkspaceMembersModal;
  window.closeWorkspaceMembersModal = closeWorkspaceMembersModal;
  window.revokeWorkspaceMember = revokeWorkspaceMember;
  window.submitGrantWorkspaceAccess = submitGrantWorkspaceAccess;
  window.toggleWmPicker = toggleWmPicker;
  window.onWmPickerChange = onWmPickerChange;
  window.addNewProfile = addNewProfile;
  window.deleteCurrentProfile = deleteCurrentProfile;
  window.confirmDeleteProfile = confirmDeleteProfile;
  window.setActiveCurrentProfile = setActiveCurrentProfile;
  window.saveCurrentProfile = saveCurrentProfile;
  window.selectProfileItem = selectProfileItem;
  // Enable GFM (tables, strikethrough, task lists) globally
  if (typeof marked !== 'undefined') {
    marked.use({ gfm: true });
  }

  window.toggleProjectMenu = () => {
    const menu = document.getElementById('project-menu');
    if (menu) menu.classList.toggle('open');
  };

  window.cloudLogout = () => {
    // Clear client-side storage (Supabase stores session in localStorage)
    try { localStorage.clear(); } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
    // Navigate to server-side logout which clears cookies and redirects
    window.location.replace('/auth/logout');
  };


  await loadSettings();
  applyTheme(state.theme);
  await applyAIVisibility();

  // Restore sidebar collapsed state
  if (localStorage.getItem('yk-sidebar-collapsed') === '1') {
    $('sidebar').classList.add('collapsed');
  }
  await loadProjects();  // must happen before loadPages
  await loadPages();
  setupEventListeners();

  // Cloud mode — show user info, logout button, storage bar
  try {
    const healthRes = await fetch('/api/health');
    const health = await healthRes.json();
    if (health.cloud) {
      state.isCloud = true;
      const userRow = document.getElementById('sidebar-user-row');
      if (userRow) userRow.style.display = '';

      // Fetch user details
      try {
        const meRes = await fetch('/api/me');
        const me = await meRes.json();
        if (me.user) {
          const emailEl = document.getElementById('sidebar-user-email');
          const tenantEl = document.getElementById('sidebar-user-tenant');
          if (emailEl && me.user.email) emailEl.textContent = me.user.email;
          if (tenantEl && me.user.tenantId) tenantEl.textContent = me.user.tenantId + '.yoinko.ai';
          if (me.user.id && me.user.email) {
            state.currentUser = { user_id: me.user.id, email: me.user.email };
            kanbanAssignableMembersLoaded = false;
          }
          state.isOwner = me.user.isOwner ?? true;
          state.userPlan = me.user.plan ?? 'basic';
          if (isCloudPlusPlan()) {
            (window as any).__yoinkoWorkspaceLimit = Infinity;
          }
          // Re-render switcher now that isOwner + plan are known
          renderProjectSwitcher();
        }
      } catch { /* ignore */ }

      await loadStorageUsage();
    }
  } catch { /* ignore */ }

  handleHashRoute();
  window.addEventListener('hashchange', handleHashRoute);
}

// ── Projects ──────────────────────────────────────────────────────────────────
async function loadProjects(): Promise<void> {
  try {
    const { projects } = await api.listProjects();
    state.projects = projects;

    // Validate stored project is accessible — for joined users the server
    // returns only the workspaces they have access to, so 'default' may not
    // be in the list. Fall back to whatever is first rather than hardcoding.
    const stored = getCurrentProjectId();
    if (!projects.find(p => p.id === stored)) {
      setCurrentProjectId(projects[0]?.id ?? 'default');
    }

    renderProjectSwitcher();
  } catch { /* silently fail — server may not have migrated yet */ }
}

function renderProjectSwitcher(): void {
  const switcher = document.getElementById('project-switcher');
  if (!switcher) return;

  // Preserve the menu's open state across re-renders (a drop reorder rebuilds
  // the menu DOM, which would otherwise visually "close" the dropdown).
  const wasMenuOpen = !!document.getElementById('project-menu')?.classList.contains('open');

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

  // Render the avatar — image if a logo is set, otherwise initials with the
  // generated background color. esc() is the existing HTML-escape helper.
  const avatarMarkup = (p: Project): string => {
    if (p.logo) {
      const url = api.projectLogoUrl(p.id, p.logo);
      return `<img src="${url}" alt="${esc(p.name)}" class="project-avatar-img"
                   onerror="this.replaceWith(Object.assign(document.createElement('span'),{
                     className:'project-avatar-fallback',
                     textContent:'${esc(initials(p.name))}'
                   }))">`;
    }
    return esc(initials(p.name));
  };

  switcher.innerHTML = `
    <button class="project-switcher-btn" onclick="toggleProjectMenu()" title="Switch project">
      <span class="project-switcher-avatar${current?.logo ? ' has-logo' : ''}" ${current?.logo ? '' : avatarStyle(currentName, currentId === 'default')}>${current ? avatarMarkup(current) : esc(initials(currentName))}</span>
      <span class="project-switcher-name">${esc(currentName)}</span>
      <svg class="project-switcher-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M 6 9 L 12 15 L 18 9"/></svg>
    </button>
    <div class="project-menu" id="project-menu">
      <div class="project-menu-label">Workspaces</div>
      ${state.projects.map(p => {
    const isActive = p.id === currentId;
    // Use <div role="button"> so we can nest real <button> inside for delete
    return `
        <div class="project-menu-item${isActive ? ' project-menu-item--active' : ''}"
             role="button" tabindex="0"
             draggable="true"
             data-project-id="${p.id}"
             onclick="switchProject('${p.id}')"
             onkeydown="if(event.key==='Enter'||event.key===' ')switchProject('${p.id}')">
          ${state.isOwner ? `<span class="project-menu-drag-handle" aria-hidden="true" title="Drag to reorder">
            <svg viewBox="0 0 12 12" width="10" height="10" fill="currentColor"><circle cx="3" cy="3" r="1.2"/><circle cx="9" cy="3" r="1.2"/><circle cx="3" cy="6" r="1.2"/><circle cx="9" cy="6" r="1.2"/><circle cx="3" cy="9" r="1.2"/><circle cx="9" cy="9" r="1.2"/></svg>
          </span>` : ''}
          <span class="project-menu-avatar${p.logo ? ' has-logo' : ''}" ${p.logo ? '' : avatarStyle(p.name, p.id === 'default')}>${avatarMarkup(p)}</span>
          <span class="project-menu-item-name">${esc(p.name)}</span>
          ${state.isOwner ? `<span class="project-menu-actions">
                 ${isCloudPlusPlan()
          ? `<button class="project-menu-action-btn"
                           onclick="event.stopPropagation();openWorkspaceMembersModal('${p.id}','${esc(p.name)}')"
                           title="Manage access">
                       <svg viewBox="0 0 12 12" fill="none" width="11" height="11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                         <circle cx="4" cy="3.5" r="1.8"/><path d="M0.5 10.5c0-2 1.6-3 3.5-3s3.5 1 3.5 3"/>
                         <circle cx="9" cy="3.5" r="1.5"/><path d="M9 7.5c1.5 0 2.5.8 2.5 2.5"/>
                       </svg>
                     </button>` : ''}
                 <button class="project-menu-action-btn"
                         onclick="event.stopPropagation();openRenameProjectModal('${p.id}','${p.name}')"
                         title="Edit workspace">
                   <svg viewBox="0 0 12 12" fill="none" width="11" height="11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
                     <path d="M8.5 1.5a1.414 1.414 0 012 2L3.5 10.5l-3 .5.5-3z"/>
                   </svg>
                 </button>
                 ${p.id !== 'default' ? `<button class="project-menu-action-btn project-menu-action-delete"
                         onclick="event.stopPropagation();deleteProjectConfirm('${p.id}','${p.name}')"
                         title="Delete workspace">
                   <svg viewBox="0 0 10 10" fill="none" width="9" height="9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
                     <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
                   </svg>
                 </button>` : ''}
               </span>` : ''}
        </div>`;
  }).join('')}
      <div class="project-menu-divider"></div>
      ${state.isOwner
      ? state.isCloud && isFinite(getWorkspaceLimit()) && state.projects.length >= getWorkspaceLimit()
        ? `<div class="project-menu-item project-menu-new project-menu-new--limit" aria-disabled="true">
               <span class="project-menu-new-icon">+</span>
               <span>New workspace <span class="project-menu-limit-badge">${state.projects.length}/${getWorkspaceLimit()}</span></span>
             </div>`
        : `<div class="project-menu-item project-menu-new"
                 role="button" tabindex="0"
                 onclick="openCreateProjectModal()"
                 onkeydown="if(event.key==='Enter')openCreateProjectModal()">
               <span class="project-menu-new-icon">+</span>
               <span>New workspace</span>
             </div>`
      : ''
    }
    </div>
  `;

  // Restore open state across re-renders (e.g. after a drop reorder) so the
  // dropdown doesn't visually close every time the workspaces are reordered.
  if (wasMenuOpen) {
    document.getElementById('project-menu')?.classList.add('open');
  }

  wireProjectMenuDragDrop();
}

// ── Workspace drag-and-drop reorder ──────────────────────────────────────────
function wireProjectMenuDragDrop(): void {
  const menu = document.getElementById('project-menu');
  if (!menu) return;
  const items = menu.querySelectorAll<HTMLElement>('.project-menu-item[data-project-id]');
  let draggingId: string | null = null;

  items.forEach(el => {
    el.addEventListener('dragstart', (e: DragEvent) => {
      draggingId = el.dataset.projectId || null;
      el.classList.add('project-menu-item--dragging');
      // Mark the menu so hover styles can quiet down while dragging.
      menu.classList.add('project-menu--dragging');
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move';
        // Some browsers require setData to start a drag.
        e.dataTransfer.setData('text/plain', el.dataset.projectId || '');
      }
    });

    el.addEventListener('dragend', () => {
      el.classList.remove('project-menu-item--dragging');
      menu.classList.remove('project-menu--dragging');
      menu.querySelectorAll('.project-menu-item--drop-before, .project-menu-item--drop-after')
        .forEach(n => n.classList.remove('project-menu-item--drop-before', 'project-menu-item--drop-after'));
      draggingId = null;
    });

    el.addEventListener('dragover', (e: DragEvent) => {
      if (!draggingId || el.dataset.projectId === draggingId) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      const rect = el.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      el.classList.toggle('project-menu-item--drop-before', before);
      el.classList.toggle('project-menu-item--drop-after', !before);
    });

    el.addEventListener('dragleave', () => {
      el.classList.remove('project-menu-item--drop-before', 'project-menu-item--drop-after');
    });

    el.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      if (!draggingId || el.dataset.projectId === draggingId) return;
      const targetId = el.dataset.projectId;
      if (!targetId) return;
      const rect = el.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      reorderWorkspace(draggingId, targetId, before);
    });
  });
}

async function reorderWorkspace(sourceId: string, targetId: string, insertBefore: boolean): Promise<void> {
  const ids = state.projects.map(p => p.id);
  const fromIdx = ids.indexOf(sourceId);
  const toIdx = ids.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

  // Compute the new order by removing source then re-inserting at target position.
  const newOrder = [...state.projects];
  const [moved] = newOrder.splice(fromIdx, 1);
  let insertAt = newOrder.indexOf(state.projects[toIdx]);
  if (!insertBefore) insertAt += 1;
  newOrder.splice(insertAt, 0, moved);

  // Optimistic UI update.
  const previous = state.projects;
  state.projects = newOrder;
  renderProjectSwitcher();

  try {
    const { projects } = await api.reorderProjects(newOrder.map(p => p.id));
    state.projects = projects;
    renderProjectSwitcher();
  } catch (err) {
    // Revert on failure.
    state.projects = previous;
    renderProjectSwitcher();
    showToast('Reorder failed: ' + (err as Error).message, 'error');
  }
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

  // Clear current page and tabs
  state.currentPageId = null;
  state.currentPage = null;
  state.chatMessages = [];
  state.openTabs = [];
  state.activeTabId = null;

  // Reload UI
  renderProjectSwitcher();
  await loadPages();

  // Auto-select the first page/folder in the new project
  const firstItem = state.pages.find(p => !p.parent_id);
  if (firstItem) {
    await navigateTo(firstItem.id);
  } else {
    const contentArea = $('content-area');
    if (contentArea) contentArea.innerHTML = '<div class="empty-state"><p>This project is empty. Create a page to get started.</p></div>';
  }
  showToast(`Switched to ${state.projects.find(p => p.id === id)?.name ?? id}`);
}

// Create project modal
const CLOUD_WORKSPACE_LIMIT = 2;
function getWorkspaceLimit(): number {
  return (window as any).__yoinkoWorkspaceLimit ?? CLOUD_WORKSPACE_LIMIT;
}

function openCreateProjectModal(): void {
  const wsLimit = getWorkspaceLimit();
  if (state.isCloud && isFinite(wsLimit) && state.projects.length >= wsLimit) {
    showToast(`Your plan allows up to ${wsLimit} workspaces.`, 'error');
    return;
  }
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
  renderRenameProjectLogoPreview();
}

function renderRenameProjectLogoPreview(): void {
  const preview = document.getElementById('rename-project-logo-preview');
  const removeBtn = document.getElementById('rename-project-logo-remove');
  if (!preview || !_renameProjectId) return;
  const project = state.projects.find(p => p.id === _renameProjectId);
  if (!project) return;

  const initials = (n: string) => n.slice(0, 2).toUpperCase();
  const hue = (n: string) => {
    let h = 0;
    for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) % 360;
    return h;
  };

  if (project.logo) {
    preview.classList.add('has-logo');
    preview.removeAttribute('style');
    preview.innerHTML = `<img src="${api.projectLogoUrl(project.id, project.logo)}" alt="${esc(project.name)}">`;
    if (removeBtn) removeBtn.style.display = '';
  } else {
    preview.classList.remove('has-logo');
    preview.style.background = project.id === 'default' ? '' : `hsl(${hue(project.name)}, 60%, 48%)`;
    preview.textContent = initials(project.name);
    if (removeBtn) removeBtn.style.display = 'none';
  }
}

function triggerProjectLogoUpload(): void {
  (document.getElementById('rename-project-logo-input') as HTMLInputElement)?.click();
}

async function handleProjectLogoUpload(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file || !_renameProjectId) return;
  // Reset the input so re-uploading the SAME file still triggers `change`.
  input.value = '';
  try {
    const { project } = await api.uploadProjectLogo(_renameProjectId, file);
    const idx = state.projects.findIndex(p => p.id === project.id);
    if (idx !== -1) state.projects[idx] = project;
    renderRenameProjectLogoPreview();
    renderProjectSwitcher();
    showToast('Logo updated');
  } catch (err) {
    showToast('Upload failed: ' + (err as Error).message, 'error');
  }
}

async function removeProjectLogo(): Promise<void> {
  if (!_renameProjectId) return;
  try {
    const { project } = await api.deleteProjectLogo(_renameProjectId);
    const idx = state.projects.findIndex(p => p.id === project.id);
    if (idx !== -1) state.projects[idx] = project;
    renderRenameProjectLogoPreview();
    renderProjectSwitcher();
    showToast('Logo removed');
  } catch (err) {
    showToast('Remove failed: ' + (err as Error).message, 'error');
  }
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

// ── Workspace members modal (plus plan, owner only) ───────────────────────────
let _workspaceMembersProjectId: string | null = null;
// { user_id, email } for all team members in this tenant (loaded once per modal open)
let _teamMembers: Array<{ user_id: string; email: string }> = [];
// user_ids currently checked in the add-members dropdown
const _selectedNewMembers = new Set<string>();

async function openWorkspaceMembersModal(id: string, name: string): Promise<void> {
  _workspaceMembersProjectId = id;
  _selectedNewMembers.clear();
  const titleEl = document.getElementById('workspace-members-title');
  if (titleEl) titleEl.textContent = `Manage access — ${name}`;
  document.getElementById('workspace-members-overlay')?.classList.add('open');

  // Show loading state immediately
  const listEl = document.getElementById('workspace-members-list');
  const pickerWrap = document.getElementById('wm-picker-wrap');
  if (listEl) listEl.innerHTML = '<div class="workspace-members-loading"><span class="wm-spinner"></span>Loading…</div>';
  if (pickerWrap) pickerWrap.innerHTML = '';

  const [teamRes, accessRes] = await Promise.allSettled([
    api.getTeamMembers(),
    api.getWorkspaceMembers(id),
  ]);
  _teamMembers = teamRes.status === 'fulfilled' ? teamRes.value.members : [];
  const granted = accessRes.status === 'fulfilled' ? accessRes.value.members : [];

  renderWorkspaceMembers(granted);
  renderTeamMemberPicker(granted);
}

function closeWorkspaceMembersModal(): void {
  document.getElementById('workspace-members-overlay')?.classList.remove('open');
  closeWmPicker();
  _workspaceMembersProjectId = null;
  _selectedNewMembers.clear();
}

function renderWorkspaceMembers(members: Array<{ user_id: string; user_email: string; role: string }>): void {
  const listEl = document.getElementById('workspace-members-list');
  if (!listEl) return;
  if (members.length === 0) {
    listEl.innerHTML = '<div class="workspace-members-empty">No members have access yet.</div>';
    return;
  }
  listEl.innerHTML = members.map(m => `
    <div class="workspace-member-row">
      <span class="workspace-member-email">${escapeHtml(m.user_email)}</span>
      <span class="workspace-member-role workspace-member-role--${m.role}">${m.role}</span>
      <button class="workspace-member-revoke icon-btn"
              onclick="revokeWorkspaceMember('${escapeHtml(m.user_id)}')"
              title="Revoke access">
        <svg viewBox="0 0 10 10" fill="none" width="10" height="10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <line x1="1" y1="1" x2="9" y2="9"/><line x1="9" y1="1" x2="1" y2="9"/>
        </svg>
      </button>
    </div>`).join('');
}

function renderTeamMemberPicker(alreadyGranted: Array<{ user_id: string }>): void {
  const grantedIds = new Set(alreadyGranted.map(m => m.user_id));
  const available = _teamMembers.filter(m => !grantedIds.has(m.user_id));
  const pickerWrap = document.getElementById('wm-picker-wrap');
  if (!pickerWrap) return;

  if (available.length === 0) {
    pickerWrap.innerHTML = '<p class="workspace-members-hint">All team members already have access.</p>';
    return;
  }

  pickerWrap.innerHTML = `
    <div class="wm-picker" id="wm-picker">
      <button type="button" class="wm-picker-trigger" id="wm-picker-trigger"
              onclick="toggleWmPicker()">
        <span id="wm-picker-label">Select team members…</span>
        <svg viewBox="0 0 12 12" fill="none" width="10" height="10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4l4 4 4-4"/></svg>
      </button>
      <div class="wm-picker-dropdown" id="wm-picker-dropdown">
        ${available.map(m => `
          <label class="wm-picker-option" data-user-id="${escapeHtml(m.user_id)}">
            <input type="checkbox" class="wm-picker-checkbox"
                   value="${escapeHtml(m.user_id)}"
                   data-email="${escapeHtml(m.email)}"
                   onchange="onWmPickerChange()">
            <span class="wm-picker-email">${escapeHtml(m.email)}</span>
          </label>`).join('')}
      </div>
    </div>
    `;
}

function closeWmPicker(): void {
  document.getElementById('wm-picker-dropdown')?.classList.remove('open');
  document.removeEventListener('mousedown', wmPickerOutsideHandler);
}

function wmPickerOutsideHandler(e: MouseEvent): void {
  const picker = document.getElementById('wm-picker');
  if (picker && !picker.contains(e.target as Node)) {
    closeWmPicker();
  }
}

function toggleWmPicker(): void {
  const dropdown = document.getElementById('wm-picker-dropdown');
  if (!dropdown) return;
  const isOpen = dropdown.classList.contains('open');
  if (isOpen) {
    closeWmPicker();
  } else {
    dropdown.classList.add('open');
    // Defer so this click doesn't immediately trigger the outside handler
    setTimeout(() => document.addEventListener('mousedown', wmPickerOutsideHandler), 0);
  }
}

function onWmPickerChange(): void {
  _selectedNewMembers.clear();
  document.querySelectorAll<HTMLInputElement>('.wm-picker-checkbox:checked').forEach(cb => {
    _selectedNewMembers.add(cb.value);
  });
  const count = _selectedNewMembers.size;
  const label = document.getElementById('wm-picker-label');
  if (label) label.textContent = count === 0 ? 'Select team members…' : `${count} member${count > 1 ? 's' : ''} selected`;
}

async function revokeWorkspaceMember(userId: string): Promise<void> {
  if (!_workspaceMembersProjectId) return;
  try {
    await api.revokeWorkspaceAccess(_workspaceMembersProjectId, userId);
    // Reload both lists
    const [accessRes] = await Promise.allSettled([api.getWorkspaceMembers(_workspaceMembersProjectId)]);
    const granted = accessRes.status === 'fulfilled' ? accessRes.value.members : [];
    renderWorkspaceMembers(granted);
    renderTeamMemberPicker(granted);
    _selectedNewMembers.clear();
  } catch (err) {
    showToast((err as Error).message, 'error');
  }
}

async function submitGrantWorkspaceAccess(): Promise<void> {
  if (!_workspaceMembersProjectId || _selectedNewMembers.size === 0) {
    showToast('Select at least one member', 'error');
    return;
  }
  const role: 'write' = 'write';
  const entries = Array.from(_selectedNewMembers).map(uid => {
    const cb = document.querySelector<HTMLInputElement>(`.wm-picker-checkbox[value="${uid}"]`);
    return { user_id: uid, user_email: cb?.dataset.email ?? '', role };
  }).filter(e => e.user_email);

  if (!entries.length) { showToast('Could not resolve member emails', 'error'); return; }

  try {
    await api.grantWorkspaceAccess(_workspaceMembersProjectId, entries);
    _selectedNewMembers.clear();
    document.getElementById('wm-picker-dropdown')?.classList.remove('open');
    const [accessRes] = await Promise.allSettled([api.getWorkspaceMembers(_workspaceMembersProjectId)]);
    const granted = accessRes.status === 'fulfilled' ? accessRes.value.members : [];
    renderWorkspaceMembers(granted);
    renderTeamMemberPicker(granted);
    showToast(`Access granted to ${entries.length} member${entries.length > 1 ? 's' : ''}`);
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

// ── AI visibility ─────────────────────────────────────────────────────────────
// Shows/hides all AI-powered UI elements based on whether any LLM profile
// exists. We do NOT gate on api_key because: (a) keyless providers like local
// Ollama are valid, (b) the server may mask the key before returning it.
async function applyAIVisibility(): Promise<void> {
  try {
    const { profiles } = await api.getProfiles();
    // Any configured profile means AI is available
    state.aiEnabled = profiles.length > 0;
  } catch {
    state.aiEnabled = false;
  }

  const show = state.aiEnabled;

  // Chat toggle FAB
  const chatToggle = document.getElementById('chat-toggle');
  if (chatToggle) chatToggle.style.display = show ? '' : 'none';


  // Chat drawer — close it if open and AI was just disabled
  if (!show && state.chatOpen) {
    state.chatOpen = false;
    document.getElementById('chat-drawer')?.classList.remove('open');
  }
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

// ── Tabs ──────────────────────────────────────────────────────────────────────

function tabStorageKey(): string {
  return `yk-tabs-${getCurrentProjectId()}`;
}
function activeTabStorageKey(): string {
  return `yk-active-tab-${getCurrentProjectId()}`;
}

function syncTabNames(): void {
  state.openTabs = state.openTabs.map(t => {
    const page = state.pages.find(p => p.id === t.pageId);
    return page ? { ...t, name: page.display_name || page.name } : t;
  });
}

function saveTabs(): void {
  try {
    localStorage.setItem(tabStorageKey(), JSON.stringify(state.openTabs));
    localStorage.setItem(activeTabStorageKey(), state.activeTabId ?? '');
  } catch { /* quota or private mode */ }
}

function loadSavedTabs(): void {
  try {
    const raw = localStorage.getItem(tabStorageKey());
    const savedActiveId = localStorage.getItem(activeTabStorageKey()) ?? '';
    if (!raw) return;
    const parsed = JSON.parse(raw) as AppTab[];
    const validIds = new Set(state.pages.map(p => p.id));
    // Refresh names from current page list, drop tabs for deleted pages
    state.openTabs = parsed
      .filter(t => validIds.has(t.pageId))
      .map(t => {
        const page = state.pages.find(p => p.id === t.pageId);
        return { ...t, name: page ? (page.display_name || page.name) : t.name };
      });
    const stillExists = state.openTabs.find(t => t.id === savedActiveId);
    state.activeTabId = stillExists ? savedActiveId : (state.openTabs[0]?.id ?? null);
    // Do NOT set state.currentPageId here — navigateTo (called by handleHashRoute)
    // will set it. Setting it here causes the early-return guard to skip rendering.
  } catch { /* corrupted data */ }
}

function pageIcon(page: PageNode | undefined, className = ''): string {
  const cls = className ? ` class="${className}"` : '';
  const yk = `${cls} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"`;
  if (!page) return `<svg ${yk}><path d="M 6 3 H 14 L 19 8 V 21 H 6 Z"/><path d="M 14 3 V 8 H 19"/></svg>`;
  if (page.type === 'folder') return `<svg ${yk}><path d="M 3 7 V 19 H 21 V 9 H 11 L 9 7 H 3 Z"/></svg>`;
  if (page.file_type === 'html') return `<svg ${yk}><path d="M 6 3 H 14 L 19 8 V 21 H 6 Z"/><path d="M 14 3 V 8 H 19"/><path d="M 9 12 H 16"/><path d="M 9 15 H 13"/></svg>`;
  if (page.file_type === 'diagram') return `<svg ${yk}><rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/><path d="M 10 7 H 13 C 15 7 16 8 16 10 V 14"/></svg>`;
  if (page.file_type === 'kanban') return `<svg ${yk}><rect x="4" y="4" width="4" height="16" rx="1.5"/><rect x="10" y="4" width="4" height="10" rx="1.5"/><rect x="16" y="4" width="4" height="13" rx="1.5"/></svg>`;
  if (page.file_type === 'sheet') return `<svg ${yk}><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M 4 10 H 20"/><path d="M 4 15 H 20"/><path d="M 10 4 V 20"/><path d="M 15 4 V 20"/></svg>`;
  return `<svg ${yk}><path d="M 6 3 H 14 L 19 8 V 21 H 6 Z"/><path d="M 14 3 V 8 H 19"/><path d="M 9 12 H 16"/><path d="M 9 15 H 16"/><path d="M 9 18 H 13"/></svg>`;
}

function renderTabBar(): void {
  const bar = $('tab-bar');
  if (!state.openTabs.length) {
    bar.style.display = 'none';
    return;
  }
  bar.style.display = '';
  const multiTab = state.openTabs.length > 1;
  bar.innerHTML = state.openTabs.map(tab => {
    const isActive = tab.id === state.activeTabId;
    const page = state.pages.find(p => p.id === tab.pageId);
    const icon = pageIcon(page);
    return `
      <div class="tab${isActive ? ' active' : ''}" onclick="switchTab('${tab.id}')">
        <span class="tab-icon">${icon}</span>
        <span class="tab-name">${esc(tab.name)}</span>
        ${multiTab ? `<button class="tab-close" onclick="closeTab('${tab.id}');event.stopPropagation()" title="Close tab">×</button>` : ''}
      </div>`;
  }).join('') + `<button class="tab-new-btn" onclick="openNewTab()" title="New tab">+</button>`;
}

function switchTab(tabId: string): void {
  const tab = state.openTabs.find(t => t.id === tabId);
  if (!tab || tabId === state.activeTabId) return;

  if (state.wysiwyg) {
    clearTimeout(saveTimer as ReturnType<typeof setTimeout>);
    state.wysiwyg = null;
  }

  state.activeTabId = tabId;
  state.currentPageId = tab.pageId;
  window.location.hash = `page/${tab.pageId}`;
  saveTabs();
  void renderPage(tab.pageId);
  renderSidebar();
  renderTabBar();
}

async function closeTab(tabId: string): Promise<void> {
  const idx = state.openTabs.findIndex(t => t.id === tabId);
  if (idx === -1) return;

  const wasActive = tabId === state.activeTabId;
  state.openTabs = state.openTabs.filter(t => t.id !== tabId);

  if (wasActive) {
    if (state.wysiwyg) {
      clearTimeout(saveTimer as ReturnType<typeof setTimeout>);
      state.wysiwyg = null;
    }
    const nextIdx = Math.min(idx, state.openTabs.length - 1);
    if (nextIdx >= 0) {
      const next = state.openTabs[nextIdx];
      state.activeTabId = next.id;
      state.currentPageId = next.pageId;
      window.location.hash = `page/${next.pageId}`;
      saveTabs();
      await renderPage(next.pageId);
      renderSidebar();
    } else {
      state.activeTabId = null;
      state.currentPageId = null;
      state.currentPage = null;
      window.location.hash = '';
      saveTabs();
      showWelcome();
      renderSidebar();
    }
  } else {
    saveTabs();
  }

  renderTabBar();
}

async function openNewTab(): Promise<void> {
  // Navigate to the first page in a fresh tab (or welcome if no pages)
  const firstPage = state.pages.find(p => !p.parent_id);
  if (firstPage) {
    await navigateTo(firstPage.id, true);
  } else {
    showWelcome();
  }
}

// ── Pages ─────────────────────────────────────────────────────────────────────
async function loadPages(): Promise<void> {
  try {
    const { pages } = await api.getFlat();
    state.pages = pages;
    loadSavedTabs();
    syncTabNames();
    renderSidebar();
    renderTabBar();
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
  Object.values(map).forEach(page => page._children.sort(compareSidebarNavNodes));

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
        ${pageIcon(page, 'nav-icon')}
        <span class="nav-name">${esc(displayName)}</span>

      </div>
      ${hasChildren ? `
        <button class="nav-expand-btn${isExpanded ? ' open' : ''}" data-folder-id="${page.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 9 6 L 15 12 L 9 18"/></svg>
        </button>
      ` : ''}
    `;
    item.addEventListener('click', (e) => {
      const isExpandBtn = (e.target as Element).closest('.nav-expand-btn');
      if (isExpandBtn) {
        toggleFolder(page.id);
      } else {
        void navigateTo(page.id, e.metaKey || e.ctrlKey);
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
    const icon = pageIcon(page, 'nav-icon');
    item.innerHTML = `
      <div class="nav-item-inner">
        ${numStr ? `<span class="nav-num">${numStr}</span>` : ''}
        ${icon}
        <span class="nav-name">${esc(displayName)}</span>
        <span class="nav-count">${ext}</span>
      </div>
    `;
    item.addEventListener('click', (e) => void navigateTo(page.id, e.metaKey || e.ctrlKey));
    item.addEventListener('contextmenu', e => showCtxMenu(e, page));
    return item;
  }
}

function buildSubNavItem(page: NavPageNode): HTMLElement {
  const displayName = page.display_name || page.name;
  const isFolder = page.type === 'folder';
  const hasChildren = page._children && page._children.length > 0;
  const isExpanded = state.expandedFolders.has(page.id);
  const icon = pageIcon(page, 'nav-sub-icon');

  const wrapper = document.createElement('div');
  const item = document.createElement('div');
  item.className = 'nav-sub-item';
  item.dataset.pageId = page.id;
  item.innerHTML = `
    ${icon}
    <span class="nav-sub-name">${esc(displayName)}</span>
    ${isFolder && hasChildren ? `
      <button class="nav-expand-btn${isExpanded ? ' open' : ''}" data-folder-id="${page.id}" aria-label="Toggle folder">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 9 6 L 15 12 L 9 18"/></svg>
      </button>
    ` : ''}
  `;
  item.addEventListener('click', (e) => void navigateTo(page.id, e.metaKey || e.ctrlKey));
  item.querySelector('.nav-expand-btn')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleFolder(page.id);
  });
  item.addEventListener('contextmenu', e => showCtxMenu(e, page));
  wrapper.appendChild(item);

  if (isFolder && hasChildren) {
    const childrenEl = document.createElement('div');
    childrenEl.className = `nav-children${isExpanded ? ' open' : ''}`;
    childrenEl.id = `children-${page.id}`;
    page._children.forEach(child => childrenEl.appendChild(buildSubNavItem(child)));
    wrapper.appendChild(childrenEl);
  }

  return wrapper;
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

function expandAncestorFolders(pageId: string): void {
  const byId = new Map(state.pages.map(p => [p.id, p]));
  let page = byId.get(pageId);
  while (page?.parent_id) {
    state.expandedFolders.add(page.parent_id);
    page = byId.get(page.parent_id);
  }
}

// ── Navigation ────────────────────────────────────────────────────────────────
async function navigateTo(pageId: string, newTab = false): Promise<void> {
  if (!newTab && pageId === state.currentPageId) return;

  if (state.wysiwyg) {
    clearTimeout(saveTimer as ReturnType<typeof setTimeout>);
    state.wysiwyg = null;
  }

  const page = state.pages.find(p => p.id === pageId);
  const name = page ? (page.display_name || page.name) : 'Page';

  if (newTab || !state.activeTabId) {
    const tabId = `tab-${Date.now()}`;
    state.openTabs = [...state.openTabs, { id: tabId, pageId, name }];
    state.activeTabId = tabId;
  } else {
    state.openTabs = state.openTabs.map(t =>
      t.id === state.activeTabId ? { ...t, pageId, name } : t
    );
  }

  state.currentPageId = pageId;
  window.location.hash = `page/${pageId}`;

  expandAncestorFolders(pageId);
  if (page?.type === 'folder') state.expandedFolders.add(pageId);

  saveTabs();
  await renderPage(pageId);
  renderSidebar();
  renderTabBar();
}

function handleHashRoute(): void {
  const hash = window.location.hash;
  const match = hash.match(/^#page\/(.+)$/);
  if (match) {
    void navigateTo(match[1]);
  } else if (state.activeTabId) {
    // No hash but restored tabs exist — render the active tab's page
    const activeTab = state.openTabs.find(t => t.id === state.activeTabId);
    if (activeTab) {
      window.location.hash = `page/${activeTab.pageId}`;
      void navigateTo(activeTab.pageId);
    } else {
      showWelcome();
    }
  } else {
    showWelcome();
  }
}

// ── Page rendering ────────────────────────────────────────────────────────────
async function renderPage(pageId: string): Promise<void> {
  // Close find bar when navigating away
  closeFindBar();
  $('find-bar').style.display = 'none';
  disposeReactToolRoots();

  const content = $('content-area');
  content.className = 'content-area';
  content.innerHTML = `<div class="fade-in" style="text-align:center;padding:60px 0;color:var(--text-dim);"><div>Loading…</div></div>`;
  hideSaveState();
  // If a Monaco HTML editor was open from a previous page, free its resources
  // — replacing innerHTML above orphans the DOM but Monaco's listeners persist.
  disposeHtmlMonacoEditor();

  try {
    const { page } = await api.getPage(pageId);
    state.currentPage = page;
    updateTopbar(page);

    const isPage = page.type === 'page';
    const isMd = page.file_type === 'md';
    const isHtml = isPage && page.file_type === 'html';

    $('html-edit-btn').classList.toggle('hidden', !isHtml);
    $('lock-page-btn')?.classList.toggle('hidden', !isPage);
    $('share-page-btn')?.classList.toggle('hidden', !isPage);
    if (isHtml) {
      // Reset edit btn label on each navigation
      $('html-edit-btn').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;display:inline-block;vertical-align:-2px;margin-right:4px"><path d="M 4 20 L 8 20 L 18 10 L 14 6 L 4 16 Z"/><path d="M 13 7 L 17 11"/></svg>Edit HTML';
    }

    if (page.type === 'folder') {
      renderFolderView(page, content);
    } else if (page.file_type === 'md') {
      renderWysiwygEditor(page, content);
    } else if (page.file_type === 'html') {
      renderHtmlEditor(page, content);
    } else if (page.file_type === 'diagram') {
      renderDiagramEditor(page, content);
    } else if (page.file_type === 'kanban') {
      renderKanbanEditor(page, content);
    } else if (page.file_type === 'sheet') {
      renderSheetEditor(page, content);
    }
  } catch (err) {
    content.innerHTML = `<div class="fade-in" style="text-align:center;padding:60px 0;color:var(--danger);">Failed to load: ${esc((err as Error).message)}</div>`;
  }
}

function updateTopbar(page: PageNode): void {
  const parent = state.pages.find(p => p.id === page.parent_id);
  $('bc-parent').textContent = parent ? (parent.display_name || parent.name) : 'yoınko';
  ($('page-title') as HTMLInputElement).value = page.display_name || page.name;
  ($('page-title') as HTMLInputElement).disabled = !!page.locked;
  $('topbar-badge').textContent = page.type === 'folder' ? 'folder' : (page.file_type || 'md');
  const lockBtn = $('lock-page-btn');
  if (lockBtn) {
    lockBtn.classList.toggle('hidden', page.type !== 'page');
    lockBtn.classList.toggle('btn-unlock-attention', !!page.locked);
    lockBtn.title = page.locked ? 'Unlock page' : 'Lock page';
    lockBtn.innerHTML = page.locked
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;display:inline-block;vertical-align:-2px;margin-right:4px"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M 8 11 V 8 a 4 4 0 0 1 8 0 v3"/></svg>Unlock'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;display:inline-block;vertical-align:-2px;margin-right:4px"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M 8 11 V 8 a 4 4 0 0 1 8 0 v3"/></svg>Lock';
  }
  const shareBtn = $('share-page-btn');
  if (shareBtn) {
    const isPublished = !!page.share?.enabled;
    shareBtn.classList.toggle('hidden', page.type !== 'page');
    shareBtn.classList.toggle('btn-published-attention', isPublished);
    shareBtn.title = isPublished ? 'Published - manage share' : 'Share read-only page';
    shareBtn.innerHTML = isPublished
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;display:inline-block;vertical-align:-2px;margin-right:4px"><path d="M 20 6 L 9 17 L 4 12"/></svg>Published'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;display:inline-block;vertical-align:-2px;margin-right:4px"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M 8.6 10.6 L 15.4 6.4"/><path d="M 8.6 13.4 L 15.4 17.6"/></svg>Share';
  }
}

// No-op stubs kept for API safety
function toggleEditMode(): void { }
function updatePreviewToggleBtn(): void { }

// ── WYSIWYG Editor (TipTap — loaded from local bundle) ───────────────────────

function tiptapToMarkdown(doc: TipTapDoc): string {
  // ── Inline (marks) ────────────────────────────────────────────────────────
  function inline(nodes?: TipTapDoc[]): string {
    if (!nodes) return '';
    return nodes.map(n => {
      if (n.type === 'hardBreak') return '  \n';
      let t = n.text || '';
      if (n.marks) {
        // code mark: no inner markdown, return immediately
        if (n.marks.some(m => m.type === 'code')) return `\`${t}\``;
        n.marks.forEach(m => {
          if (m.type === 'bold') t = `**${t}**`;
          else if (m.type === 'italic') t = `*${t}*`;
          else if (m.type === 'strike') t = `~~${t}~~`;
          else if (m.type === 'underline') t = `<u>${t}</u>`;
          else if (m.type === 'link') t = `[${t}](${(m.attrs?.href as string) || ''})`;
        });
      }
      return t;
    }).join('');
  }

  // ── List item ─────────────────────────────────────────────────────────────
  function serializeListItem(node: TipTapDoc, prefix: string): string {
    const c = node.content || [];
    if (c.length === 0) return prefix + '\n';
    const first = c[0];
    const textLine = first.type === 'paragraph'
      ? inline(first.content).trimEnd()
      : blk(first).trimEnd();
    // Nested lists indented by 4 spaces
    const nested = c.slice(1).map(n => blk(n).replace(/^(?=.)/gm, '    ')).join('');
    return prefix + textLine + '\n' + nested;
  }

  // ── Block ─────────────────────────────────────────────────────────────────
  function blk(node: TipTapDoc): string {
    const t = node.type;
    const c = node.content || [];

    if (t === 'doc') return c.map(n => blk(n)).join('\n');
    if (t === 'paragraph') return inline(c) + '\n';
    if (t === 'heading') return '#'.repeat((node.attrs?.level as number) || 1) + ' ' + inline(c) + '\n';
    if (t === 'horizontalRule') return '---\n';

    if (t === 'codeBlock') {
      const lang = (node.attrs?.language as string) || '';
      const code = c.map(n => n.text || '').join('');
      return `\`\`\`${lang}\n${code}\n\`\`\`\n`;
    }

    if (t === 'blockquote') {
      return c.map(n => blk(n).replace(/^/gm, '> ').replace(/> $/gm, '>').trimEnd())
        .join('\n') + '\n';
    }

    if (t === 'bulletList') return c.map(n => serializeListItem(n, '- ')).join('');
    if (t === 'orderedList') {
      let i = (node.attrs?.start as number) || 1;
      return c.map(n => serializeListItem(n, `${i++}. `)).join('');
    }

    if (t === 'taskList') {
      return c.map(n => {
        const checked = n.attrs?.checked;
        const checkbox = checked ? '[x]' : '[ ]';
        const children = n.content || [];
        const first = children[0];
        const textPart = first
          ? (first.type === 'paragraph' ? inline(first.content).trimEnd() : blk(first).trimEnd())
          : '';
        const nested = children.slice(1).map(n2 => blk(n2).replace(/^(?=.)/gm, '    ')).join('');
        return `- ${checkbox} ${textPart}\n${nested}`;
      }).join('');
    }

    if (t === 'hardBreak') return '  \n';
    if (t === 'text') return node.text || '';

    if (t === 'table') {
      const rows = c.map((row, rowIdx) => {
        const cells = (row.content || []).map(cell => {
          return (cell.content || []).map(n => blk(n)).join('').replace(/\n/g, ' ').trim();
        });
        const rowStr = '| ' + cells.join(' | ') + ' |';
        if (rowIdx === 0) {
          const sep = '| ' + cells.map(() => '----------').join(' | ') + ' |';
          return rowStr + '\n' + sep;
        }
        return rowStr;
      });
      return rows.join('\n') + '\n';
    }

    return c.map(n => blk(n)).join('');
  }

  try {
    return blk(doc).replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  } catch {
    return '';
  }
}

function renderWysiwygEditor(page: PageNode, container: HTMLElement): void {
  container.className = 'content-area wysiwyg-wrap fade-in';
  const locked = !!page.locked;
  container.innerHTML = `
    <div class="wysiwyg-page${locked ? ' is-locked' : ''}">
      ${locked ? '<div class="tool-readonly-banner">Locked. Unlock this page before editing.</div>' : ''}
      ${locked ? '' : `<div class="editor-toolbar" id="editor-toolbar" role="toolbar" aria-label="Formatting">

        <!-- History -->
        <button class="tb-btn" id="tb-undo" title="Undo (⌘Z)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 3 7 V 13 H 9"/><path d="M 21 17 a 9 9 0 0 0 -15 -6.7 L 3 13"/></svg>
        </button>
        <button class="tb-btn" id="tb-redo" title="Redo (⌘⇧Z)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 21 7 V 13 H 15"/><path d="M 3 17 a 9 9 0 0 1 15 -6.7 L 21 13"/></svg>
        </button>

        <span class="tb-sep"></span>

        <!-- Heading dropdown -->
        <div class="tb-dropdown" id="tb-heading-wrap">
          <button class="tb-btn tb-dropdown-btn" id="tb-heading" title="Text style">
            <span class="tb-heading-label" id="tb-heading-label">Text</span>
            <svg class="tb-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 6 9 L 12 15 L 18 9"/></svg>
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
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 7 4 H 13 a 4 4 0 0 1 0 8 H 7 V 4 Z"/><path d="M 7 12 H 14 a 4 4 0 0 1 0 8 H 7 V 12 Z"/></svg>
        </button>
        <button class="tb-btn" id="tb-italic" title="Italic (⌘I)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 8 5 H 17"/><path d="M 7 19 H 16"/><path d="M 14 5 L 10 19"/></svg>
        </button>
        <button class="tb-btn" id="tb-underline" title="Underline (⌘U)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 6 4 V 13 a 6 6 0 0 0 12 0 V 4"/><path d="M 4 20 H 20"/></svg>
        </button>
        <button class="tb-btn" id="tb-strike" title="Strikethrough">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 17 7 c 0 -2 -3 -3 -5 -3 c -3 0 -5 1 -5 3 c 0 4 10 2 10 6 c 0 2 -3 3 -5 3 c -2 0 -5 -1 -5 -3"/><path d="M 4 12 H 20"/></svg>
        </button>
        <button class="tb-btn" id="tb-code" title="Inline code">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 9 8 L 5 12 L 9 16"/><path d="M 15 8 L 19 12 L 15 16"/><path d="M 13 6 L 11 18"/></svg>
        </button>

        <span class="tb-sep"></span>

        <!-- Block nodes -->
        <button class="tb-btn" id="tb-bullet" title="Bullet list">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="1.5" fill="currentColor"/><path d="M 9 6 H 20"/><circle cx="5" cy="12" r="1.5" fill="currentColor"/><path d="M 9 12 H 20"/><circle cx="5" cy="18" r="1.5" fill="currentColor"/><path d="M 9 18 H 20"/></svg>
        </button>
        <button class="tb-btn" id="tb-ordered" title="Numbered list">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 10 6 H 21"/><path d="M 10 12 H 21"/><path d="M 10 18 H 21"/><path d="M 4 4 L 4 9"/><path d="M 2.5 5 L 4 4"/><path d="M 2 13 a 2 1.5 0 0 1 4 0 L 2 17 H 6"/><path d="M 2 19 a 2 1.5 0 0 1 4 0 a 2 1.5 0 0 1 -4 0 H 6"/></svg>
        </button>
        <button class="tb-btn" id="tb-task" title="Task list">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="5" height="5" rx="1"/><path d="M 4 6.5 L 5.2 7.7 L 7 5.5"/><path d="M 11 6.5 H 20"/><rect x="3" y="11" width="5" height="5" rx="1"/><path d="M 11 13.5 H 20"/><rect x="3" y="18" width="5" height="5" rx="1"/><path d="M 11 20.5 H 20"/></svg>
        </button>
        <button class="tb-btn" id="tb-blockquote" title="Blockquote">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path fill="currentColor" stroke="none" d="M 4 7 H 9 V 13 a 4 4 0 0 1 -5 4 V 14 a 1.5 1.5 0 0 0 1.5 -1.5 V 13 H 4 Z"/><path fill="currentColor" stroke="none" d="M 13 7 H 18 V 13 a 4 4 0 0 1 -5 4 V 14 a 1.5 1.5 0 0 0 1.5 -1.5 V 13 H 13 Z"/></svg>
        </button>
        <button class="tb-btn" id="tb-codeblock" title="Code block">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M 8 9 L 5 12 L 8 15"/><path d="M 16 9 L 19 12 L 16 15"/><path d="M 12 8 L 10 16"/></svg>
        </button>

        <span class="tb-sep"></span>

        <!-- Link -->
        <div class="tb-dropdown" id="tb-link-wrap">
          <button class="tb-btn" id="tb-link" title="Link (⌘K)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 10 14 a 4 4 0 0 1 0 -6 L 13 5 a 4 4 0 0 1 6 6 L 17 13"/><path d="M 14 10 a 4 4 0 0 1 0 6 L 11 19 a 4 4 0 0 1 -6 -6 L 7 11"/></svg>
          </button>
          <div class="tb-dropdown-menu tb-link-menu" id="tb-link-menu">
            <!-- Tabs -->
            <div class="tb-link-tabs">
              <button class="tb-link-tab active" id="tb-tab-url" data-tab="url">URL</button>
              <button class="tb-link-tab" id="tb-tab-page" data-tab="page">Page</button>
            </div>

            <!-- URL panel -->
            <div class="tb-link-panel" id="tb-panel-url">
              <input class="tb-link-input" id="tb-link-input" type="url" placeholder="https://…" autocomplete="off" spellcheck="false" />
              <div class="tb-link-actions">
                <button class="tb-link-ok" id="tb-link-ok">Apply</button>
                <button class="tb-link-remove" id="tb-link-remove">Remove</button>
              </div>
            </div>

            <!-- Page picker panel -->
            <div class="tb-link-panel hidden" id="tb-panel-page">
              <input class="tb-link-input" id="tb-page-search" type="text" placeholder="Search pages…" autocomplete="off" spellcheck="false" />
              <div class="tb-page-list" id="tb-page-list"></div>
            </div>
          </div>
        </div>

        <button class="tb-btn" id="tb-hr" title="Horizontal rule">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 3 12 H 21"/><circle cx="3" cy="12" r="1" fill="currentColor"/><circle cx="21" cy="12" r="1" fill="currentColor"/></svg>
        </button>

      </div>`}
      <div id="wysiwyg-editor" class="tiptap-host" spellcheck="true"></div>
      <div class="tiptap-hint${locked ? ' hidden' : ''}">
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
    try { state.wysiwyg.destroy(); } catch { /* already destroyed */ }
    state.wysiwyg = null;
  }

  if (!window.TipTapBundle) {
    showToast('Editor bundle not loaded — please refresh', 'error');
    console.error('TipTapBundle not found on window');
    return;
  }

  const { Editor, Extension, InputRule, StarterKit, TaskList, TaskItem, Placeholder, Table, TableRow, TableCell, TableHeader, Underline, Link, ListKeymap } = window.TipTapBundle;

  // Trigger a task list when the user types `[]`, `[ ]`, `[x]`, or `[X]`
  // (with optional inner whitespace) followed by a space at the start of a
  // block. If the cursor is currently inside a `bulletList` (because the
  // user just typed `- ` first, which auto-wrapped them in a bullet), we
  // `clearNodes()` first to lift the paragraph out of the bulletList —
  // otherwise `toggleTaskList()` would nest a `taskList` *inside* the
  // bulletList, producing the visible "2-tab jump".
  const TaskBracketRule = Extension.create({
    name: 'taskBracketRule',
    addInputRules() {
      return [
        new InputRule({
          find: /^\[\s*[xX]?\s*\]\s$/,
          handler: ({ chain, range }: {
            chain: () => {
              deleteRange: (r: unknown) => {
                clearNodes: () => {
                  toggleTaskList: () => { run: () => void };
                };
              };
            };
            range: unknown;
          }) => {
            chain().deleteRange(range).clearNodes().toggleTaskList().run();
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
      (Table as { configure: (opts: Record<string, unknown>) => unknown }).configure({ resizable: false }),
      TableRow,
      TableCell,
      TableHeader,
      Underline,
      (Link as { configure: (opts: Record<string, unknown>) => unknown }).configure({
        openOnClick: false,
        validate: () => true,
        HTMLAttributes: { rel: 'noopener noreferrer' },
      }),
      ListKeymap,
      Placeholder.configure({
        placeholder: 'Start writing… Use # for headings, [] for tasks, - for lists',
      }),
    ],
    content: initialHtml,
    autofocus: !locked,
    editable: !locked,
    editorProps: {
      attributes: { class: 'tiptap-content', spellcheck: 'true' },
      // Copy/cut → write markdown to the clipboard's text/plain MIME type so
      // pasting outside the editor (chat, terminal, another app) lands as
      // proper Markdown instead of unstyled plain text. text/html still
      // carries the rich representation, so paste-back into TipTap (or
      // another rich editor) keeps full formatting.
      clipboardTextSerializer: (slice: { content: { toJSON: () => unknown } }) => {
        const json = slice.content.toJSON() as TipTapDoc[] | undefined;
        if (!json || !json.length) return '';
        const allInline = json.every(
          n => n.type === 'text' || n.type === 'hardBreak',
        );
        const content: TipTapDoc[] = allInline
          ? [{ type: 'paragraph', content: json }]
          : json;
        return tiptapToMarkdown({ type: 'doc', content }).replace(/\n+$/, '');
      },
    },
    onUpdate({ editor }: { editor: { getJSON: () => TipTapDoc } }) {
      if (locked) return;
      const md = tiptapToMarkdown(editor.getJSON());
      debounceSave(md);
      if (state.currentPage) state.currentPage.content = md;
    },
  });

  state.wysiwyg = editor;

  // Wire up toolbar
  buildEditorToolbar(editor);

  $('wysiwyg-editor').addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if ((ke.metaKey || ke.ctrlKey) && ke.key === 's') {
      ke.preventDefault();
      savePage(tiptapToMarkdown(editor.getJSON()));
    }
  }, true);
}

// ── Editor Toolbar ────────────────────────────────────────────────────────────
function buildEditorToolbar(editor: TipTapEditor): void {
  const toolbar = document.getElementById('editor-toolbar');
  if (!toolbar) return;

  // ── Active state refresh ──────────────────────────────────────────────────
  const marks = ['bold', 'italic', 'underline', 'strike', 'code'];
  const blocks = ['bulletList', 'orderedList', 'taskList', 'blockquote', 'codeBlock'];

  function refreshActive(): void {
    marks.forEach(m => {
      document.getElementById(`tb-${m}`)?.classList
        .toggle('active', editor.isActive(m));
    });
    blocks.forEach(b => {
      const id = b === 'bulletList' ? 'tb-bullet'
        : b === 'orderedList' ? 'tb-ordered'
          : b === 'taskList' ? 'tb-task'
            : b === 'blockquote' ? 'tb-blockquote'
              : 'tb-codeblock';
      document.getElementById(id)?.classList.toggle('active', editor.isActive(b));
    });
    // Headings — update button label + active state
    const hBtn = document.getElementById('tb-heading');
    const hLabel = document.getElementById('tb-heading-label');
    if (hBtn && hLabel) {
      const activeLevel = [1, 2, 3, 4].find(l => editor.isActive('heading', { level: l }));
      hBtn.classList.toggle('active', !!activeLevel);
      hLabel.textContent = activeLevel ? `H${activeLevel}` : 'Text';
    }
    // Link
    document.getElementById('tb-link')?.classList.toggle('active', editor.isActive('link'));
  }

  editor.on('transaction', refreshActive);
  refreshActive();

  // ── Simple button actions ─────────────────────────────────────────────────
  function btn(id: string, action: () => void): void {
    document.getElementById(id)?.addEventListener('mousedown', (e) => {
      e.preventDefault(); // keep editor focus
      action();
    });
  }

  btn('tb-undo', () => editor.chain().focus().undo().run());
  btn('tb-redo', () => editor.chain().focus().redo().run());
  btn('tb-bold', () => editor.chain().focus().toggleBold().run());
  btn('tb-italic', () => editor.chain().focus().toggleItalic().run());
  btn('tb-underline', () => editor.chain().focus().toggleUnderline().run());
  btn('tb-strike', () => editor.chain().focus().toggleStrike().run());
  btn('tb-code', () => editor.chain().focus().toggleCode().run());
  btn('tb-bullet', () => editor.chain().focus().toggleBulletList().run());
  btn('tb-ordered', () => editor.chain().focus().toggleOrderedList().run());
  btn('tb-task', () => editor.chain().focus().toggleTaskList().run());
  btn('tb-blockquote', () => editor.chain().focus().toggleBlockquote().run());
  btn('tb-codeblock', () => editor.chain().focus().toggleCodeBlock().run());
  btn('tb-hr', () => editor.chain().focus().setHorizontalRule().run());

  // ── Heading dropdown ──────────────────────────────────────────────────────
  const headingWrap = document.getElementById('tb-heading-wrap');
  const headingMenu = document.getElementById('tb-heading-menu');
  const headingBtn = document.getElementById('tb-heading');

  headingBtn?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    headingMenu?.classList.toggle('open');
    linkMenu?.classList.remove('open');
  });

  headingMenu?.querySelectorAll<HTMLButtonElement>('[data-level]').forEach(item => {
    item.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const level = parseInt(item.dataset.level || '0');
      if (level === 0) {
        // Set paragraph
        (editor.chain().focus() as unknown as { setParagraph: () => TipTapChain }).setParagraph().run();
      } else {
        editor.chain().focus().toggleHeading({ level }).run();
      }
      headingMenu.classList.remove('open');
    });
  });

  // ── Link dropdown (tabbed: URL / Page picker) ─────────────────────────────
  const linkWrap = document.getElementById('tb-link-wrap');
  const linkMenu = document.getElementById('tb-link-menu');
  const linkBtn = document.getElementById('tb-link');
  const linkInput = document.getElementById('tb-link-input') as HTMLInputElement | null;
  const linkOk = document.getElementById('tb-link-ok');
  const linkRemove = document.getElementById('tb-link-remove');
  const tabUrl = document.getElementById('tb-tab-url');
  const tabPage = document.getElementById('tb-tab-page');
  const panelUrl = document.getElementById('tb-panel-url');
  const panelPage = document.getElementById('tb-panel-page');
  const pageSearch = document.getElementById('tb-page-search') as HTMLInputElement | null;
  const pageList = document.getElementById('tb-page-list');

  // ── Tab switching ──────────────────────────────────────────────────────────
  function switchTab(tab: 'url' | 'page'): void {
    tabUrl?.classList.toggle('active', tab === 'url');
    tabPage?.classList.toggle('active', tab === 'page');
    panelUrl?.classList.toggle('hidden', tab !== 'url');
    panelPage?.classList.toggle('hidden', tab !== 'page');
    if (tab === 'url') {
      setTimeout(() => linkInput?.focus(), 10);
    } else {
      populatePageList('');
      setTimeout(() => pageSearch?.focus(), 10);
    }
  }

  tabUrl?.addEventListener('mousedown', (e) => { e.preventDefault(); switchTab('url'); });
  tabPage?.addEventListener('mousedown', (e) => { e.preventDefault(); switchTab('page'); });

  // ── Page list builder ──────────────────────────────────────────────────────
  function populatePageList(query: string): void {
    if (!pageList) return;
    const q = query.toLowerCase().trim();
    pageList.innerHTML = '';

    // Helper: create a single list row
    function makeItem(p: { id: string; name: string; display_name: string; type: string; parent_id?: string | null }, depth: number): HTMLButtonElement {
      const item = document.createElement('button');
      item.className = 'tb-page-item';
      item.type = 'button';
      item.dataset.type = p.type;

      // Indent spacer
      if (depth > 0) {
        const indent = document.createElement('span');
        indent.className = 'tb-page-indent';
        indent.style.width = `${depth * 14}px`;
        indent.style.flexShrink = '0';
        item.appendChild(indent);
      }

      // Icon — folder or file
      const icon = document.createElement('span');
      icon.className = 'tb-page-item-icon';
      icon.innerHTML = p.type === 'folder'
        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 3 7 V 19 H 21 V 9 H 11 L 9 7 H 3 Z"/></svg>`
        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 6 3 H 14 L 19 8 V 21 H 6 Z"/><path d="M 14 3 V 8 H 19"/><path d="M 9 12 H 16"/><path d="M 9 15 H 16"/></svg>`;
      item.appendChild(icon);

      // Label + path
      const labelWrap = document.createElement('span');
      labelWrap.className = 'tb-page-item-label';

      const nameEl = document.createElement('span');
      nameEl.className = 'tb-page-item-name';
      nameEl.textContent = p.display_name || p.name;
      labelWrap.appendChild(nameEl);

      const pathEl = document.createElement('span');
      pathEl.className = 'tb-page-item-path';
      pathEl.textContent = p.name; // human-readable slug, not the base64 id
      labelWrap.appendChild(pathEl);

      item.appendChild(labelWrap);

      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        editor.chain().focus().setLink({ href: `#page/${p.id}`, target: '_self' }).run();
        linkMenu?.classList.remove('open');
      });

      return item;
    }

    if (q) {
      // ── Search mode: flat filtered list, no indentation ────────────────────
      const matches = state.pages.filter(p =>
        p.display_name.toLowerCase().includes(q) || p.name.toLowerCase().includes(q)
      );
      if (matches.length === 0) {
        pageList.innerHTML = '<div class="tb-page-empty">No results found</div>';
        return;
      }
      matches.forEach(p => pageList!.appendChild(makeItem(p, 0)));
    } else {
      // ── Tree mode: depth-first traversal with indentation ──────────────────
      const childMap = new Map<string, typeof state.pages>();
      state.pages.forEach(p => {
        const key = p.parent_id || '';
        if (!childMap.has(key)) childMap.set(key, []);
        childMap.get(key)!.push(p);
      });

      // Sort children: folders before pages
      childMap.forEach((children) => {
        children.sort((a, b) => {
          if (a.type === b.type) return (a.display_name || a.name).localeCompare(b.display_name || b.name);
          return a.type === 'folder' ? -1 : 1;
        });
      });

      function traverse(parentId: string, depth: number): void {
        const children = childMap.get(parentId) || [];
        children.forEach(p => {
          pageList!.appendChild(makeItem(p, depth));
          traverse(p.id, depth + 1);
        });
      }

      if ((childMap.get('') || []).length === 0) {
        pageList.innerHTML = '<div class="tb-page-empty">No pages yet</div>';
        return;
      }

      traverse('', 0);
    }

  }

  pageSearch?.addEventListener('input', () => populatePageList(pageSearch.value));
  pageSearch?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') linkMenu?.classList.remove('open');
    if (e.key === 'Enter') {
      // Pick the first visible item
      const first = pageList?.querySelector('.tb-page-item') as HTMLButtonElement | null;
      first?.click();
    }
  });

  // ── Open link menu ─────────────────────────────────────────────────────────
  linkBtn?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const wasOpen = linkMenu?.classList.contains('open');
    linkMenu?.classList.toggle('open');
    headingMenu?.classList.remove('open');
    if (!wasOpen && linkMenu?.classList.contains('open')) {
      // Pre-fill URL tab if cursor is on a link
      const attrs = editor.isActive('link')
        ? (editor as unknown as { getAttributes: (n: string) => Record<string, unknown> }).getAttributes('link')
        : {};
      const existingHref = (attrs.href as string) || '';
      if (linkInput) linkInput.value = existingHref;
      // Reset to URL tab on open
      switchTab('url');
    }
  });

  // ── Apply URL ──────────────────────────────────────────────────────────────
  linkOk?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const url = linkInput?.value.trim() || '';
    if (url) editor.chain().focus().setLink({ href: url, target: '_blank' }).run();
    linkMenu?.classList.remove('open');
  });

  linkInput?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const url = linkInput.value.trim();
      if (url) editor.chain().focus().setLink({ href: url, target: '_blank' }).run();
      linkMenu?.classList.remove('open');
    }
    if (e.key === 'Escape') linkMenu?.classList.remove('open');
  });

  linkRemove?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    editor.chain().focus().unsetLink().run();
    linkMenu?.classList.remove('open');
  });

  // Close dropdowns on outside click
  document.addEventListener('mousedown', (e) => {
    if (!headingWrap?.contains(e.target as Node)) headingMenu?.classList.remove('open');
    if (!linkWrap?.contains(e.target as Node)) linkMenu?.classList.remove('open');
  }, { capture: true });
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

// Lazy-load Monaco editor. The CDN loader script (in index.html) exposes a
// global `require` function that we configure with the correct `vs` path,
// then ask it for the editor.main module. Resolves to `window.monaco`.
let _monacoLoadPromise: Promise<unknown> | null = null;
function loadMonaco(): Promise<unknown> {
  if (_monacoLoadPromise) return _monacoLoadPromise;
  _monacoLoadPromise = new Promise((resolve, reject) => {
    const w = window as unknown as {
      monaco?: unknown;
      require?: { config: (o: unknown) => void } & ((mods: string[], cb: () => void, err?: (e: Error) => void) => void);
    };
    if (w.monaco) { resolve(w.monaco); return; }
    if (!w.require) { reject(new Error('Monaco loader (loader.js) not available')); return; }
    w.require.config({ paths: { vs: 'https://cdn.jsdelivr.net/npm/monaco-editor@0.52.2/min/vs' } });
    w.require(['vs/editor/editor.main'], () => resolve((window as { monaco?: unknown }).monaco), reject);
  });
  return _monacoLoadPromise;
}

interface MonacoEditorInstance {
  dispose: () => void;
  getValue: () => string;
  focus: () => void;
  onDidChangeModelContent: (cb: () => void) => void;
  addCommand: (k: number, cb: () => void) => void;
}
let _htmlMonacoEditor: MonacoEditorInstance | null = null;

function disposeHtmlMonacoEditor(): void {
  if (_htmlMonacoEditor) {
    try { _htmlMonacoEditor.dispose(); } catch { /* ignore */ }
    _htmlMonacoEditor = null;
  }
}

// ── Full-screen code file editor ──────────────────────────────────────────────

const CODE_EXTS = new Set([
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'php', 'cs', 'cpp', 'cc', 'c', 'h', 'hpp',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'css', 'scss', 'sass', 'less',
  'sql', 'graphql', 'gql', 'proto',
  'json', 'yaml', 'yml', 'toml', 'xml', 'html', 'htm', 'md', 'markdown',
  'env', 'ini', 'conf', 'cfg',
  'dockerfile', 'makefile', 'gitignore', 'editorconfig',
]);

const EXT_TO_MONACO_LANG: Record<string, string> = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift', php: 'php',
  cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell', ps1: 'powershell', bat: 'bat',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  sql: 'sql', graphql: 'graphql', gql: 'graphql', proto: 'protobuf',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  html: 'html', htm: 'html', md: 'markdown', markdown: 'markdown',
};

let _codeEditorAssetId: string | null = null;
let _codeMonacoEditor: MonacoEditorInstance | null = null;

function isCodeFile(filename: string): boolean {
  const ext = filename.split('.').pop()?.toLowerCase() ?? '';
  return CODE_EXTS.has(ext);
}

async function openCodeFileEditor(id: string, name: string, url: string): Promise<void> {
  _codeEditorAssetId = id;

  const overlay = $('code-editor-overlay');
  const host = $('code-editor-host');
  const filenameEl = $('code-editor-filename');

  filenameEl.textContent = name;
  host.innerHTML = '<div style="padding:32px;color:var(--text-dim);font-size:14px;">Loading…</div>';
  overlay.style.display = 'flex';

  // Dispose any previous instance
  if (_codeMonacoEditor) {
    try { _codeMonacoEditor.dispose(); } catch { /* ignore */ }
    _codeMonacoEditor = null;
  }

  try {
    const res = await fetch(url);
    const text = await res.text();

    const monaco = await loadMonaco() as {
      editor: {
        create: (el: HTMLElement, opts: Record<string, unknown>) => MonacoEditorInstance;
      };
      KeyMod: { CtrlCmd: number };
      KeyCode: { KeyS: number };
    };

    host.innerHTML = '';
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const language = EXT_TO_MONACO_LANG[ext] ?? 'plaintext';

    _codeMonacoEditor = monaco.editor.create(host, {
      value: text,
      language,
      theme: state.theme === 'dark' ? 'vs-dark' : 'vs',
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: true },
      scrollBeyondLastLine: false,
      tabSize: 2,
      wordWrap: 'off',
    });

    // Ctrl/Cmd+S to save
    _codeMonacoEditor.addCommand(
      (monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS) as unknown as number,
      () => void saveCodeFile()
    );

    _codeMonacoEditor.focus();
  } catch (err) {
    host.innerHTML = `<div style="padding:32px;color:var(--danger);font-size:14px;">Failed to load file: ${(err as Error).message}</div>`;
  }
}

function closeCodeFileEditor(): void {
  const overlay = $('code-editor-overlay');
  overlay.style.display = 'none';
  if (_codeMonacoEditor) {
    try { _codeMonacoEditor.dispose(); } catch { /* ignore */ }
    _codeMonacoEditor = null;
  }
  _codeEditorAssetId = null;
}

async function saveCodeFile(): Promise<void> {
  if (!_codeEditorAssetId || !_codeMonacoEditor) return;
  const content = _codeMonacoEditor.getValue();
  const btn = $('code-editor-save-btn');
  try {
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;display:inline-block;vertical-align:-2px;margin-right:4px"><path d="M 12 4 V 16"/><path d="M 7 12 L 12 17 L 17 12"/><path d="M 4 20 H 20"/></svg>Saving…';
    btn.setAttribute('disabled', 'true');
    await api.updateAssetContent(_codeEditorAssetId, content);
    showToast('File saved');
  } catch (err) {
    showToast('Save failed: ' + (err as Error).message, 'error');
  } finally {
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;display:inline-block;vertical-align:-2px;margin-right:4px"><path d="M 12 4 V 16"/><path d="M 7 12 L 12 17 L 17 12"/><path d="M 4 20 H 20"/></svg>Save';
    btn.removeAttribute('disabled');
  }
}

function toggleHtmlEditMode(): void {
  const container = $('content-area');
  const page = state.currentPage;
  if (!page) return;
  if (page.locked) {
    showToast('Unlock this page before editing', 'error');
    return;
  }

  const isEditing = container.classList.contains('editor-mode');

  if (isEditing) {
    // Switch back to preview-only
    disposeHtmlMonacoEditor();
    container.className = 'content-area fade-in';
    container.innerHTML = `
      <iframe class="html-preview-frame" id="html-preview-frame" style="width:100%;height:100%;border:none;display:block"></iframe>
    `;
    ($('html-preview-frame') as HTMLIFrameElement).srcdoc = page.content || '<p>Empty page</p>';
    $('html-edit-btn').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;display:inline-block;vertical-align:-2px;margin-right:4px"><path d="M 4 20 L 8 20 L 18 10 L 14 6 L 4 16 Z"/><path d="M 13 7 L 17 11"/></svg>Edit HTML';
    return;
  }

  // Switch to split editor + preview. The left pane hosts Monaco; the right
  // pane is the live preview iframe.
  container.className = 'content-area editor-mode fade-in';
  container.innerHTML = `
    <div class="editor-pane html-editor-wrap" style="flex:1">
      <div class="editor-pane-label"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;display:inline-block;vertical-align:-2px;margin-right:4px"><path d="M 4 20 L 8 20 L 18 10 L 14 6 L 4 16 Z"/><path d="M 13 7 L 17 11"/></svg>html source</div>
      <div id="editor-monaco-host" style="flex:1;min-height:0"></div>
    </div>
    <div class="editor-pane html-editor-wrap" style="flex:1;border-right:none">
      <div class="editor-pane-label">👁 live preview</div>
      <iframe class="html-preview-frame" id="html-preview-frame"></iframe>
    </div>
  `;
  const host = $('editor-monaco-host');
  const frame = $('html-preview-frame') as HTMLIFrameElement;
  frame.srcdoc = page.content || '<p>Empty page</p>';
  $('html-edit-btn').textContent = '👁 Preview';

  void mountHtmlEditor(host, page, frame);
}

async function mountHtmlEditor(host: HTMLElement, page: PageNode, frame: HTMLIFrameElement): Promise<void> {
  try {
    const monaco = await loadMonaco() as {
      editor: {
        create: (el: HTMLElement, opts: Record<string, unknown>) => MonacoEditorInstance;
      };
      KeyMod: { CtrlCmd: number };
      KeyCode: { KeyS: number };
    };
    disposeHtmlMonacoEditor();
    _htmlMonacoEditor = monaco.editor.create(host, {
      value: page.content || '',
      language: 'html',
      theme: state.theme === 'dark' ? 'vs-dark' : 'vs',
      automaticLayout: true,
      fontSize: 14,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      tabSize: 2,
      wordWrap: 'on',
      formatOnPaste: true,
      formatOnType: true,
    });

    const update = () => {
      const value = _htmlMonacoEditor!.getValue();
      frame.srcdoc = value || '<p>Empty page</p>';
      debounceSave(value);
      if (state.currentPage) state.currentPage.content = value;
    };
    _htmlMonacoEditor.onDidChangeModelContent(update);
    _htmlMonacoEditor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      savePage(_htmlMonacoEditor!.getValue());
    });
    setTimeout(() => _htmlMonacoEditor?.focus(), 50);
  } catch {
    // Fallback to a plain textarea if Monaco fails to load (no network, CSP block, etc).
    host.innerHTML = `<textarea class="editor-textarea" id="editor-textarea" placeholder="Write HTML…" spellcheck="false" style="flex:1;width:100%;height:100%;border:none;outline:none;padding:10px;box-sizing:border-box;resize:none">${esc(page.content || '')}</textarea>`;
    const textarea = host.querySelector('#editor-textarea') as HTMLTextAreaElement;
    const updateFrame = () => { frame.srcdoc = textarea.value || '<p>Empty page</p>'; };
    textarea.addEventListener('input', () => { updateFrame(); debounceSave(textarea.value); if (state.currentPage) state.currentPage.content = textarea.value; });
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
    setTimeout(() => textarea.focus(), 50);
  }
}

// ── Auto-save ─────────────────────────────────────────────────────────────────
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function debounceSave(content: string): void {
  if (state.currentPage?.locked) return;
  clearTimeout(saveTimer);
  showSavingState();
  saveTimer = setTimeout(() => savePage(content), 1000);
}

async function savePage(content: string): Promise<void> {
  if (!state.currentPageId) return;
  if (state.currentPage?.locked) {
    showToast('Unlock this page before editing', 'error');
    return;
  }
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

async function saveToolDoc<T>(doc: T): Promise<void> {
  await savePage(JSON.stringify(doc, null, 2));
}

function renderToolShell(container: HTMLElement, title: string, locked: boolean, body: string): void {
  container.className = 'content-area fade-in tool-page';
  container.innerHTML = `
    <div class="tool-surface">
      <div class="tool-header">
        <h2>${esc(title)}</h2>
        ${locked ? '<span class="tool-lock-pill">Locked</span>' : ''}
      </div>
      ${locked ? '<div class="tool-readonly-banner">This file is locked. Unlock it before making changes.</div>' : ''}
      ${body}
    </div>
  `;
}

function toolPageTitle(page: PageNode): string {
  return page.display_name || page.name || 'Untitled';
}

function renderDiagramEditor(page: PageNode, container: HTMLElement): void {
  const locked = !!page.locked;
  const doc = normalizeDiagramDoc(page.content);
  renderToolShell(container, toolPageTitle(page), locked, '<div id="diagram-flow-root" class="diagram-flow-root"></div>');
  const host = $('diagram-flow-root');
  diagramRoot = createRoot(host);
  diagramRoot.render(withSentryErrorBoundary(
    React.createElement(DiagramFlowEditor, {
      initialDoc: doc,
      locked,
      onSave: async (nextDoc: DiagramDoc) => {
        if (!state.currentPage || state.currentPage.locked) return;
        state.currentPage.content = JSON.stringify(nextDoc, null, 2);
        await saveToolDoc(nextDoc);
      },
    }),
    'The diagram editor failed to render.',
  ));
}

function DiagramFlowNode({ data, selected }: NodeProps<DiagramNode>): React.ReactElement {
  const color = data.color || '#fff3bf';
  const kind = data.kind || 'box';
  const label = String(data.label || 'Untitled');
  const isText = kind === 'text';
  return React.createElement('div', {
    className: `diagram-flow-node diagram-flow-node-${kind}${selected ? ' is-selected' : ''}`,
    style: isText ? undefined : { background: color },
  },
    isText ? null : React.createElement(Handle, { id: 'top-in', type: 'target', position: Position.Top }),
    isText ? null : React.createElement(Handle, { id: 'right-out', type: 'source', position: Position.Right }),
    isText ? null : React.createElement(Handle, { id: 'bottom-out', type: 'source', position: Position.Bottom }),
    isText ? null : React.createElement(Handle, { id: 'left-in', type: 'target', position: Position.Left }),
    React.createElement('div', { className: 'diagram-flow-node-label' }, label));
}

function DiagramFlowEditor({ initialDoc, locked, onSave }: ReactFlowProps): React.ReactElement {
  const [nodes, setNodes, onNodesChangeBase] = useNodesState<DiagramNode>(initialDoc.nodes);
  const [edges, setEdges, onEdgesChangeBase] = useEdgesState<DiagramEdge>(initialDoc.edges);
  const [selected, setSelected] = useState<{ nodeIds: string[]; edgeIds: string[] }>({ nodeIds: [], edgeIds: [] });
  const [renameDraft, setRenameDraft] = useState<{ id: string; label: string } | null>(null);
  const mountedRef = useRef(false);
  const dirtyRef = useRef(false);
  const latestDocRef = useRef<DiagramDoc>(initialDoc);
  const saveTimerRef = useRef<number | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (renameDraft) renameInputRef.current?.focus();
  }, [renameDraft]);

  useEffect(() => {
    latestDocRef.current = {
      nodes: nodes.map(node => withDiagramNodeStyle(node)),
      edges,
    };
  }, [nodes, edges]);

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      if (dirtyRef.current && !locked) void onSave(latestDocRef.current);
    };
  }, [locked, onSave]);

  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    if (locked) return;
    dirtyRef.current = true;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      dirtyRef.current = false;
      void onSave(latestDocRef.current);
    }, 350);
  }, [nodes, edges, locked, onSave]);

  const onNodesChange = useCallback((changes: NodeChange<DiagramNode>[]) => {
    if (!locked) onNodesChangeBase(changes);
  }, [locked, onNodesChangeBase]);

  const onEdgesChange = useCallback((changes: Parameters<typeof onEdgesChangeBase>[0]) => {
    if (!locked) onEdgesChangeBase(changes);
  }, [locked, onEdgesChangeBase]);

  const onConnect = useCallback((connection: Connection) => {
    if (locked) return;
    setEdges(current => addEdge({
      ...connection,
      markerEnd: { type: MarkerType.ArrowClosed },
      style: { strokeWidth: 2 },
    }, current));
  }, [locked, setEdges]);

  const addNode = useCallback((label: string, color: string, kind: DiagramNodeKind) => {
    if (locked) return;
    setNodes(current => [
      ...current,
      createDiagramNode(label, {
        x: 120 + current.length * 28,
        y: 120 + current.length * 24,
      }, color, kind),
    ]);
  }, [locked, setNodes]);

  const renameNode: NodeMouseHandler<DiagramNode> = useCallback((_event, node) => {
    if (locked) return;
    setRenameDraft({ id: node.id, label: String(node.data.label || '') });
  }, [locked]);

  const closeRenameModal = useCallback(() => {
    setRenameDraft(null);
  }, []);

  const submitRename = useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renameDraft) return;
    const label = renameDraft.label.trim() || 'Untitled';
    setNodes(current => current.map(item => item.id === renameDraft.id
      ? withDiagramNodeStyle({ ...item, data: { ...item.data, label } })
      : item));
    setRenameDraft(null);
  }, [renameDraft, setNodes]);

  const setSelectedColor = useCallback((color: string) => {
    if (locked || selected.nodeIds.length === 0) return;
    setNodes(current => current.map(node => selected.nodeIds.includes(node.id)
      ? withDiagramNodeStyle({ ...node, data: { ...node.data, color }, style: { ...(node.style || {}), background: color } })
      : node));
  }, [locked, selected.nodeIds, setNodes]);

  const deleteSelected = useCallback(() => {
    if (locked) return;
    setNodes(current => current.filter(node => !selected.nodeIds.includes(node.id)));
    setEdges(current => current.filter(edge => !selected.edgeIds.includes(edge.id) && !selected.nodeIds.includes(edge.source) && !selected.nodeIds.includes(edge.target)));
    setSelected({ nodeIds: [], edgeIds: [] });
  }, [locked, selected, setNodes, setEdges]);

  const selectionHandler = useCallback(({ nodes: selectedNodes, edges: selectedEdges }: OnSelectionChangeParams<DiagramNode, DiagramEdge>) => {
    setSelected({
      nodeIds: selectedNodes.map(node => node.id),
      edgeIds: selectedEdges.map(edge => edge.id),
    });
  }, []);

  const nodeTypes = useMemo(() => ({ yoinko: DiagramFlowNode }), []);
  const defaultEdgeOptions = useMemo(() => ({
    markerEnd: { type: MarkerType.ArrowClosed },
    style: { strokeWidth: 2 },
  }), []);
  const selectedColor = nodes.find(node => selected.nodeIds.includes(node.id))?.data.color || '#fff3bf';

  return React.createElement('div', { className: 'diagram-flow-shell' },
    React.createElement('div', { className: 'tool-actions diagram-flow-actions' },
      React.createElement('button', { className: 'btn btn-sm btn-ghost', onClick: () => addNode('New box', '#d0ebff', 'box'), disabled: locked }, 'Add Box'),
      React.createElement('button', { className: 'btn btn-sm btn-ghost', onClick: () => addNode('Note', '#fff3bf', 'note'), disabled: locked }, 'Add Note'),
      React.createElement('button', { className: 'btn btn-sm btn-ghost', onClick: () => addNode('Text', 'transparent', 'text'), disabled: locked }, 'Add Text'),
      React.createElement('label', { className: 'diagram-color-control' },
        React.createElement('span', null, 'Color'),
        React.createElement('input', {
          type: 'color',
          value: selectedColor,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setSelectedColor(event.currentTarget.value),
          disabled: locked || selected.nodeIds.length === 0,
        })),
      React.createElement('button', {
        className: 'btn btn-sm btn-ghost',
        onClick: deleteSelected,
        disabled: locked || (selected.nodeIds.length === 0 && selected.edgeIds.length === 0),
      }, 'Delete Selected')),
    React.createElement('div', { className: 'diagram-flow-canvas' },
      React.createElement(ReactFlow<DiagramNode, DiagramEdge>, {
        nodes,
        edges,
        nodeTypes,
        onNodesChange,
        onEdgesChange,
        onConnect,
        onNodeDoubleClick: renameNode,
        onSelectionChange: selectionHandler,
        defaultEdgeOptions,
        fitView: true,
        nodesDraggable: !locked,
        nodesConnectable: !locked,
        edgesReconnectable: !locked,
        elementsSelectable: true,
        panOnScroll: true,
        selectionOnDrag: !locked,
        proOptions: { hideAttribution: true },
        children: [
          React.createElement(Background, { key: 'background', gap: 24, color: 'rgba(21,21,21,.16)' }),
          React.createElement(MiniMap, { key: 'minimap', pannable: true, zoomable: true }),
          React.createElement(Controls, { key: 'controls', showInteractive: !locked }),
        ],
      })),
    renameDraft ? React.createElement('div', { className: 'diagram-modal-backdrop', role: 'presentation', onMouseDown: closeRenameModal },
      React.createElement('form', {
        className: 'diagram-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'diagram-rename-title',
        onSubmit: submitRename,
        onMouseDown: (event: React.MouseEvent) => event.stopPropagation(),
      },
        React.createElement('h3', { id: 'diagram-rename-title' }, 'Rename Node'),
        React.createElement('input', {
          ref: renameInputRef,
          value: renameDraft.label,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => setRenameDraft({ ...renameDraft, label: event.currentTarget.value }),
          maxLength: 120,
        }),
        React.createElement('div', { className: 'diagram-modal-actions' },
          React.createElement('button', { type: 'button', className: 'btn btn-sm btn-ghost', onClick: closeRenameModal }, 'Cancel'),
          React.createElement('button', { type: 'submit', className: 'btn btn-sm btn-primary' }, 'Save')))) : null);
}

function renderKanbanEditor(page: PageNode, container: HTMLElement): void {
  const locked = !!page.locked;
  const doc = parseJson<KanbanDoc>(page.content, { tasks: [] });
  const assignmentsEnabled = isCloudPlusPlan();
  renderToolShell(container, toolPageTitle(page), locked, '<div id="kanban-kit-root" class="kanban-kit-root"></div>');
  container.classList.add('kanban-tool-page');
  const host = $('kanban-kit-root');
  kanbanRoot = createRoot(host);
  const renderBoard = (members: TeamMember[], membersLoading: boolean) => {
    kanbanRoot?.render(withSentryErrorBoundary(
      React.createElement(KanbanKitEditor, {
        initialDoc: doc,
        locked,
        assignableMembers: members,
        assignmentsEnabled,
        membersLoading,
        onSave: async (nextDoc: KanbanDoc) => {
          if (!state.currentPage || state.currentPage.locked) return;
          state.currentPage.content = JSON.stringify(nextDoc, null, 2);
          await saveToolDoc(nextDoc);
        },
      }),
      'The kanban board failed to render.',
    ));
  };

  renderBoard(assignmentsEnabled ? kanbanAssignableMembers : [], assignmentsEnabled && !kanbanAssignableMembersLoaded);

  if (assignmentsEnabled && !kanbanAssignableMembersLoaded) {
    void loadKanbanAssignableMembers().then(members => {
      if (state.currentPageId !== page.id || !kanbanRoot) return;
      renderBoard(members, false);
    });
  }
}

const KANBAN_COLUMN_TONES = ['tomato', 'mustard', 'sky', 'mint', 'plum'] as const;

function kanbanIcon(name: 'plus' | 'trash' | 'grip' | 'flag' | 'columns' | 'user'): React.ReactElement {
  const common = {
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };
  const paths: Record<typeof name, React.ReactNode[]> = {
    plus: [
      React.createElement('path', { key: 'h', d: 'M 5 12 H 19' }),
      React.createElement('path', { key: 'v', d: 'M 12 5 V 19' }),
    ],
    trash: [
      React.createElement('path', { key: 'lid', d: 'M 4 7 H 20' }),
      React.createElement('path', { key: 'can', d: 'M 10 11 V 17' }),
      React.createElement('path', { key: 'can2', d: 'M 14 11 V 17' }),
      React.createElement('path', { key: 'box', d: 'M 6 7 L 7 20 H 17 L 18 7' }),
      React.createElement('path', { key: 'top', d: 'M 9 7 V 4 H 15 V 7' }),
    ],
    grip: [
      React.createElement('path', { key: 'a', d: 'M 8 6 H 8.01' }),
      React.createElement('path', { key: 'b', d: 'M 8 12 H 8.01' }),
      React.createElement('path', { key: 'c', d: 'M 8 18 H 8.01' }),
      React.createElement('path', { key: 'd', d: 'M 16 6 H 16.01' }),
      React.createElement('path', { key: 'e', d: 'M 16 12 H 16.01' }),
      React.createElement('path', { key: 'f', d: 'M 16 18 H 16.01' }),
    ],
    flag: [
      React.createElement('path', { key: 'pole', d: 'M 6 21 V 5' }),
      React.createElement('path', { key: 'flag', d: 'M 6 5 H 17 L 15 10 L 17 15 H 6' }),
    ],
    columns: [
      React.createElement('rect', { key: 'a', x: 4, y: 5, width: 5, height: 14, rx: 1 }),
      React.createElement('rect', { key: 'b', x: 11, y: 5, width: 5, height: 14, rx: 1 }),
      React.createElement('path', { key: 'c', d: 'M 20 7 V 17' }),
    ],
    user: [
      React.createElement('circle', { key: 'head', cx: 12, cy: 8, r: 4 }),
      React.createElement('path', { key: 'body', d: 'M 4 21 C 5.4 16.8 8.2 15 12 15 C 15.8 15 18.6 16.8 20 21' }),
    ],
  };
  return React.createElement('svg', common, paths[name]);
}

function kanbanPriorityLabel(priority: Priority | undefined): string {
  return priority === 'high' ? 'High' : priority === 'low' ? 'Low' : 'Medium';
}

function kanbanMemberInitials(email: string): string {
  const local = email.split('@')[0]?.replace(/[._-]+/g, ' ').trim() || email;
  const parts = local.split(/\s+/).filter(Boolean);
  const initials = (parts[0]?.[0] || '') + (parts[1]?.[0] || '');
  return (initials || local.slice(0, 2) || '?').toUpperCase();
}

function kanbanMemberLabel(member: TeamMember): string {
  return member.user_id === state.currentUser?.user_id ? 'Me' : member.email;
}

function kanbanAssigneeOptions(members: TeamMember[], content: KanbanCardContent): TeamMember[] {
  if (!content.assignee_id) return members;
  if (members.some(member => member.user_id === content.assignee_id)) return members;
  return [{
    user_id: content.assignee_id,
    email: content.assignee_email || 'Unknown member',
  }, ...members];
}

function kanbanColumnToneClass(columnIds: string[], columnId: string): string {
  const index = Math.max(0, columnIds.indexOf(columnId));
  return `kanban-tone-${KANBAN_COLUMN_TONES[index % KANBAN_COLUMN_TONES.length]}`;
}

function KanbanTaskCard({
  card,
  locked,
  assignableMembers,
  assignmentsEnabled,
  membersLoading,
  onUpdate,
  onDelete,
}: {
  card: BoardItem;
  locked: boolean;
  assignableMembers: TeamMember[];
  assignmentsEnabled: boolean;
  membersLoading: boolean;
  onUpdate: (id: string, patch: Partial<KanbanTask>) => void;
  onDelete: (id: string) => void;
}): React.ReactElement {
  const content = (card.content || {}) as KanbanCardContent;
  const priority = content.priority || 'medium';
  const stopPointer = (event: React.PointerEvent<HTMLElement>) => event.stopPropagation();
  const stopClick = (event: React.MouseEvent<HTMLElement>) => event.stopPropagation();
  const priorities: Priority[] = ['low', 'medium', 'high'];
  const assigneeOptions = kanbanAssigneeOptions(assignableMembers, content);
  const selectedAssignee = assigneeOptions.find(member => member.user_id === content.assignee_id);
  const assigneeSelectDisabled = locked || membersLoading || (!assigneeOptions.length && !content.assignee_id);
  return React.createElement(
    'article',
    { className: `kanban-kit-card priority-${priority}` },
    React.createElement(
      'div',
      { className: 'kanban-kit-card-top' },
      React.createElement(
        'label',
        { className: 'kanban-title-field' },
        React.createElement('span', null, 'Title'),
        React.createElement('input', {
          className: 'kanban-kit-title',
          value: card.title,
          disabled: locked,
          onPointerDown: stopPointer,
          onChange: (event: React.ChangeEvent<HTMLInputElement>) => onUpdate(card.id, { title: event.currentTarget.value }),
        }),
      ),
      React.createElement('button', {
        type: 'button',
        className: 'kanban-kit-delete',
        disabled: locked,
        title: 'Delete task',
        'aria-label': 'Delete task',
        onPointerDown: stopPointer,
        onClick: () => onDelete(card.id),
      }, kanbanIcon('trash')),
    ),
    React.createElement('div', { className: 'kanban-ticket-divider', 'aria-hidden': true }),
    React.createElement(
      'div',
      { className: 'kanban-kit-card-footer' },
      React.createElement(
        'div',
        { className: 'kanban-field kanban-field-priority', role: 'group', 'aria-label': 'Priority' },
        React.createElement('span', null, kanbanIcon('flag'), 'Priority'),
        React.createElement(
          'div',
          { className: 'kanban-priority-control' },
          priorities.map(item => React.createElement('button', {
            key: item,
            type: 'button',
            className: `kanban-priority-option priority-${item}${priority === item ? ' is-selected' : ''}`,
            disabled: locked,
            'aria-pressed': priority === item,
            onPointerDown: stopPointer,
            onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
              stopClick(event);
              onUpdate(card.id, { priority: item });
            },
          },
            React.createElement('span', { className: `kanban-priority-dot priority-${item}`, 'aria-hidden': true }),
            React.createElement('span', null, kanbanPriorityLabel(item)),
          )),
        ),
      ),
      assignmentsEnabled ? React.createElement(
        'div',
        { className: 'kanban-field kanban-field-assignee' },
        React.createElement('span', null, kanbanIcon('user'), 'Assignee'),
        React.createElement(
          'div',
          { className: 'kanban-assignee-control' },
          React.createElement(
            'span',
            { className: `kanban-assignee-avatar${selectedAssignee ? '' : ' is-empty'}`, 'aria-hidden': true },
            selectedAssignee ? kanbanMemberInitials(selectedAssignee.email) : '-',
          ),
          React.createElement(
            'select',
            {
              className: 'kanban-assignee-select',
              value: content.assignee_id || '',
              disabled: assigneeSelectDisabled,
              'aria-label': 'Assignee',
              onPointerDown: stopPointer,
              onClick: stopClick,
              onChange: (event: React.ChangeEvent<HTMLSelectElement>) => {
                const member = assigneeOptions.find(item => item.user_id === event.currentTarget.value);
                onUpdate(card.id, {
                  assignee_id: member?.user_id || '',
                  assignee_email: member?.email || '',
                });
              },
            },
            React.createElement('option', { value: '' }, membersLoading ? 'Loading members...' : 'Unassigned'),
            assigneeOptions.map(member => React.createElement('option', {
              key: member.user_id,
              value: member.user_id,
            }, kanbanMemberLabel(member))),
          ),
        ),
      ) : null,
    ),
  );
}

function KanbanKitEditor({ initialDoc, locked, assignableMembers, assignmentsEnabled, membersLoading, onSave }: KanbanReactProps): React.ReactElement {
  const [dataSource, setDataSource] = useState<BoardData>(() => kanbanDocToBoardData(initialDoc));
  const columnIds = dataSource.root?.children || [];
  const columns = columnIds
    .map(columnId => dataSource[columnId])
    .filter((column): column is BoardItem => !!column);
  const cards = Object.values(dataSource).filter((item): item is BoardItem => !!item && item.type === 'card');
  const highPriorityCount = cards.filter(card => ((card.content || {}) as KanbanCardContent).priority === 'high').length;
  const assignedCount = cards.filter(card => !!((card.content || {}) as KanbanCardContent).assignee_id).length;

  const commitBoard = useCallback((nextDataSource: BoardData) => {
    const normalized = normalizeKanbanBoardData(nextDataSource);
    setDataSource(normalized);
    void onSave(boardDataToKanbanDoc(normalized));
  }, [onSave]);

  const updateTask = useCallback((id: string, patch: Partial<KanbanTask>) => {
    if (locked) return;
    const task = dataSource[id];
    if (!task) return;
    const content = {
      ...((task.content || {}) as KanbanCardContent),
    };
    if (patch.priority !== undefined) {
      content.priority = patch.priority;
    }
    if (patch.assignee_id !== undefined) {
      if (patch.assignee_id) {
        content.assignee_id = patch.assignee_id;
        content.assignee_email = patch.assignee_email || '';
      } else {
        delete content.assignee_id;
        delete content.assignee_email;
      }
    }
    commitBoard({
      ...dataSource,
      [id]: {
        ...task,
        title: patch.title ?? task.title,
        content,
      },
    });
  }, [commitBoard, dataSource, locked]);

  const updateColumnTitle = useCallback((id: string, title: string) => {
    if (locked) return;
    const column = dataSource[id];
    if (!column || column.parentId !== 'root') return;
    commitBoard({
      ...dataSource,
      [id]: {
        ...column,
        title,
      },
    });
  }, [commitBoard, dataSource, locked]);

  const deleteTask = useCallback((id: string) => {
    if (locked) return;
    const task = dataSource[id];
    if (!task?.parentId) return;
    const parent = dataSource[task.parentId];
    if (!parent) return;
    const { [id]: _removed, ...withoutTask } = dataSource;
    const children = parent.children.filter(childId => childId !== id);
    commitBoard({
      ...withoutTask,
      [parent.id]: {
        ...parent,
        children,
        totalChildrenCount: children.length,
      },
    } as BoardData);
  }, [commitBoard, dataSource, locked]);

  const addTask = useCallback((column: BoardItem) => {
    if (locked) return;
    openTextInputModal('Add Task', '', title => {
      const id = uid('task');
      const children = [...column.children, id];
      commitBoard({
        ...dataSource,
        [column.id]: {
          ...column,
          children,
          totalChildrenCount: children.length,
        },
        [id]: {
          id,
          title,
          parentId: column.id,
          children: [],
          totalChildrenCount: 0,
          type: 'card',
          content: { priority: 'medium' } satisfies KanbanCardContent,
        },
      });
    });
  }, [commitBoard, dataSource, locked]);

  const addColumn = useCallback(() => {
    if (locked) return;
    openTextInputModal('Add Column', '', title => {
      const id = uid('column');
      commitBoard({
        ...dataSource,
        root: {
          ...dataSource.root,
          children: [...(dataSource.root?.children || []), id],
          totalChildrenCount: (dataSource.root?.children || []).length + 1,
        },
        [id]: {
          id,
          title,
          parentId: 'root',
          children: [],
          totalChildrenCount: 0,
          isDraggable: true,
        },
      });
    });
  }, [commitBoard, dataSource, locked]);

  const deleteColumn = useCallback((columnId: string) => {
    if (locked) return;
    const column = dataSource[columnId];
    if (!column || column.parentId !== 'root') return;
    const rootChildren = (dataSource.root?.children || []).filter(id => id !== columnId);
    if (!rootChildren.length) {
      showToast('Keep at least one column', 'error');
      return;
    }
    void showConfirmDelete(column.title, 'Delete column?').then(confirmed => {
      if (!confirmed) return;
      const nextDataSource = { ...dataSource };
      delete nextDataSource[columnId];
      for (const taskId of column.children || []) delete nextDataSource[taskId];
      nextDataSource.root = {
        ...dataSource.root,
        children: rootChildren,
        totalChildrenCount: rootChildren.length,
      };
      commitBoard(nextDataSource);
    });
  }, [commitBoard, dataSource, locked]);

  const onCardMove = useCallback((move: KanbanKitDropCardParams) => {
    if (locked) return;
    commitBoard(dropHandler(
      move,
      dataSource,
      (_targetColumn, droppedItem: BoardItem) => ({ ...droppedItem, parentId: move.toColumnId }),
    ) as BoardData);
  }, [commitBoard, dataSource, locked]);

  const onColumnMove = useCallback((move: KanbanKitDropColumnParams) => {
    if (locked) return;
    commitBoard(dropColumnHandler(move, dataSource) as BoardData);
  }, [commitBoard, dataSource, locked]);

  const configMap = useMemo<KanbanKitConfigMap>(() => ({
    card: {
      isDraggable: !locked,
      render: ({ data }) => React.createElement(KanbanTaskCard, {
        card: data,
        locked,
        assignableMembers,
        assignmentsEnabled,
        membersLoading,
        onUpdate: updateTask,
        onDelete: deleteTask,
      }),
    },
  }), [assignableMembers, assignmentsEnabled, deleteTask, locked, membersLoading, updateTask]);

  return React.createElement('section', { className: `kanban-workbench${locked ? ' is-locked' : ''}` },
    React.createElement('div', { className: 'kanban-workbench-head' },
      React.createElement('div', { className: 'kanban-workbench-title' },
        React.createElement('span', { className: 'kanban-kicker' }, `${columns.length} lanes`),
        React.createElement('h3', null, cards.length ? `${cards.length} tasks in motion` : 'No tasks yet')),
      React.createElement('div', { className: 'kanban-stat-strip', 'aria-label': 'Board summary' },
        React.createElement('div', { className: 'kanban-stat' },
          React.createElement('span', null, 'Tasks'),
          React.createElement('strong', null, String(cards.length))),
        React.createElement('div', { className: 'kanban-stat is-hot' },
          React.createElement('span', null, 'High'),
          React.createElement('strong', null, String(highPriorityCount))),
        assignmentsEnabled ? React.createElement('div', { className: 'kanban-stat is-assigned' },
          React.createElement('span', null, 'Assigned'),
          React.createElement('strong', null, String(assignedCount))) : null,
        React.createElement('div', { className: 'kanban-stat' },
          React.createElement('span', null, 'Lanes'),
          React.createElement('strong', null, String(columns.length)))),
      !locked ? React.createElement('button', {
        type: 'button',
        className: 'kanban-toolbar-btn',
        onClick: addColumn,
      }, kanbanIcon('columns'), 'Add Column') : null),
    React.createElement(Kanban, {
      dataSource,
      configMap,
      viewOnly: locked,
      rootClassName: 'yoinko-kanban-kit',
      columnWrapperClassName: column => `kanban-kit-column-wrap ${kanbanColumnToneClass(columnIds, column.id)}${column.children.length ? '' : ' is-empty'}`,
      columnClassName: () => 'kanban-kit-column-shell',
      columnListContentClassName: () => 'kanban-kit-column-list',
      virtualization: false,
      cardsGap: 14,
      onCardMove,
      allowColumnDrag: !locked,
      onColumnMove,
      renderColumnHeader: column => React.createElement('div', { className: 'kanban-kit-column-head' },
        React.createElement('div', { className: 'kanban-kit-column-label' },
          React.createElement('span', { className: 'kanban-column-grip', title: locked ? undefined : 'Drag lane' }, kanbanIcon('grip')),
          React.createElement('input', {
            className: 'kanban-kit-column-title kanban-kit-column-title-input',
            value: column.title,
            disabled: locked,
            placeholder: 'Column name',
            'aria-label': 'Column name',
            onPointerDown: (event: React.PointerEvent<HTMLInputElement>) => event.stopPropagation(),
            onClick: (event: React.MouseEvent<HTMLInputElement>) => event.stopPropagation(),
            onChange: (event: React.ChangeEvent<HTMLInputElement>) => updateColumnTitle(column.id, event.currentTarget.value),
          })),
        React.createElement('div', { className: 'kanban-kit-column-actions' },
          React.createElement('span', { className: 'kanban-kit-count' }, String(column.totalChildrenCount)),
          !locked ? React.createElement('button', {
            type: 'button',
            className: 'kanban-kit-delete-column',
            title: 'Delete column',
            'aria-label': 'Delete column',
            onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation();
              deleteColumn(column.id);
            },
          }, kanbanIcon('trash')) : null)),
      allowListFooter: () => !locked,
      renderListFooter: column => React.createElement('div', { className: 'kanban-kit-list-footer' },
        !column.children.length ? React.createElement('div', { className: 'kanban-empty-lane' }, 'No tasks') : null,
        React.createElement('button', {
          type: 'button',
          className: 'kanban-kit-add-card',
          onClick: () => addTask(column),
        }, kanbanIcon('plus'), 'Add task')),
      allowColumnAdder: false,
      renderCardDragIndicator: () => React.createElement('div', { className: 'kanban-kit-card-indicator' }),
      renderColumnDragIndicator: (_column, info) => React.createElement('div', {
        className: `kanban-kit-column-indicator is-${info.edge}`,
        style: { width: info.width, height: info.height },
      }),
    }));
}

function sheetIcon(name: 'rows' | 'columns' | 'row-plus' | 'column-plus' | 'sheet-plus' | 'search' | 'filter'): string {
  const yk = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const icons = {
    rows: `<svg ${yk}><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M 4 10 H 20"/><path d="M 4 15 H 20"/></svg>`,
    columns: `<svg ${yk}><rect x="4" y="5" width="16" height="14" rx="2"/><path d="M 10 5 V 19"/><path d="M 15 5 V 19"/></svg>`,
    'row-plus': `<svg ${yk}><rect x="4" y="5" width="16" height="11" rx="2"/><path d="M 4 10 H 20"/><path d="M 12 19 V 23"/><path d="M 10 21 H 14"/></svg>`,
    'column-plus': `<svg ${yk}><rect x="4" y="5" width="11" height="14" rx="2"/><path d="M 9 5 V 19"/><path d="M 19 10 V 14"/><path d="M 17 12 H 21"/></svg>`,
    'sheet-plus': `<svg ${yk}><rect x="4" y="4" width="13" height="16" rx="2"/><path d="M 8 8 H 13"/><path d="M 8 12 H 13"/><path d="M 18 13 V 19"/><path d="M 15 16 H 21"/></svg>`,
    search: `<svg ${yk}><circle cx="11" cy="11" r="6"/><path d="M 16 16 L 21 21"/></svg>`,
    filter: `<svg ${yk}><path d="M 4 5 H 20 L 14 12 V 19 L 10 21 V 12 Z"/></svg>`,
  };
  return icons[name];
}

function renderSheetEditor(page: PageNode, container: HTMLElement): void {
  const locked = !!page.locked;
  const doc = parseJson<SheetDoc>(page.content, { cells: [['']] });
  const sheets = normalizeSheetTabs(doc);
  const firstCells = normalizeSheetCells(sheets[0]?.cells);
  const rowCount = firstCells.length;
  const colCount = firstCells[0]?.length || 1;
  renderToolShell(container, 'Spreadsheet', locked, `
    <div class="sheet-workbench">
      <div class="sheet-control-bar">
        <div class="sheet-stats" aria-label="Sheet size">
          <span>${sheetIcon('rows')}<strong id="sheet-row-count">${rowCount}</strong> Rows</span>
          <span>${sheetIcon('columns')}<strong id="sheet-column-count">${colCount}</strong> Columns</span>
        </div>
        <label class="sheet-search-field" for="sheet-search-input">
          ${sheetIcon('search')}
          <input id="sheet-search-input" type="search" placeholder="Search sheet" autocomplete="off" spellcheck="false">
        </label>
        <div class="tool-actions sheet-actions">
          <button id="sheet-add-row-btn" class="btn btn-sm btn-ghost sheet-action-btn" ${locked ? 'disabled' : ''}>${sheetIcon('row-plus')}Add Row</button>
          <button id="sheet-add-column-btn" class="btn btn-sm btn-ghost sheet-action-btn" ${locked ? 'disabled' : ''}>${sheetIcon('column-plus')}Add Column</button>
          <button id="sheet-add-sheet-btn" class="btn btn-sm btn-ghost sheet-action-btn" ${locked ? 'disabled' : ''}>${sheetIcon('sheet-plus')}Add Sheet</button>
        </div>
      </div>
      <div class="sheet-wrap"><div id="sheet-grid-root" class="sheet-grid-root"></div></div>
    </div>
  `);
  container.classList.add('sheet-tool-page');

  $('sheet-add-row-btn')?.addEventListener('click', addSheetRow);
  $('sheet-add-column-btn')?.addEventListener('click', addSheetColumn);
  $('sheet-add-sheet-btn')?.addEventListener('click', addSheet);
  $('sheet-search-input')?.addEventListener('input', () => handleSheetSearch(true));

  sheetHost = $('sheet-grid-root') as HTMLDivElement;
  sheetPageId = page.id;
  sheetEventsReady = false;
  sheetHost.addEventListener('click', () => {
    setTimeout(() => {
      syncActiveSheetFromSpreadsheet();
      bindSheetTabRename();
    }, 0);
  });

  const handleSheetMutation = (instance: SheetWorksheet, syncFilters = false) => {
    if (!sheetEventsReady) return;
    if (syncFilters) scheduleSheetFilterRowSync(instance);
    updateSheetStats(instance);
    scheduleSheetSave(instance);
  };

  const worksheets = jspreadsheet(sheetHost, {
    about: false,
    allowExport: true,
    toolbar: locked ? false : (customizeSheetToolbar as (toolbar: SheetToolbarItem[]) => SheetToolbarItem[]),
    contextMenu: customizeSheetContextMenu,
    tabs: true,
    onload: instance => {
      sheetSpreadsheet = instance;
      sheetWorksheet = instance.worksheets[0] || null;
      sheetEventsReady = true;
      if (sheetWorksheet) {
        syncSheetFilterRow(sheetWorksheet);
        updateSheetStats(sheetWorksheet);
      }
      bindSheetTabRename();
    },
    oncreateworksheet: worksheet => {
      sheetWorksheet = worksheet;
      if (!sheetSpreadsheet) sheetSpreadsheet = worksheet.parent;
      handleSheetSearch(false);
      handleSheetMutation(worksheet);
      setTimeout(() => {
        syncSheetFilterRow(worksheet);
        bindSheetTabRename();
      }, 0);
    },
    ondeleteworksheet: (_worksheet, index) => {
      if (sheetSpreadsheet) {
        sheetWorksheet = sheetSpreadsheet.worksheets[Math.max(0, index - 1)] || sheetSpreadsheet.worksheets[0] || null;
      }
      if (sheetWorksheet) handleSheetMutation(sheetWorksheet);
      setTimeout(bindSheetTabRename, 0);
    },
    onfocus: instance => {
      sheetWorksheet = instance;
      updateSheetStats(instance);
    },
    onafterchanges: instance => handleSheetMutation(instance),
    oninsertrow: instance => handleSheetMutation(instance),
    oninsertcolumn: instance => handleSheetMutation(instance, true),
    ondeleterow: instance => handleSheetMutation(instance),
    ondeletecolumn: instance => handleSheetMutation(instance, true),
    onmoverow: instance => handleSheetMutation(instance),
    onmovecolumn: instance => handleSheetMutation(instance),
    onchangeheader: instance => handleSheetMutation(instance),
    onchangestyle: instance => handleSheetMutation(instance),
    onresizecolumn: instance => handleSheetMutation(instance),
    onresizerow: instance => handleSheetMutation(instance),
    onsort: instance => handleSheetMutation(instance),
    worksheets: sheets.map((sheet, index) => createSheetWorksheetOptions(sheet, locked, index)),
  });
  sheetWorksheet = worksheets[0] || null;
  setTimeout(bindSheetTabRename, 0);
}

function normalizeSheetTabs(doc: SheetDoc): SheetWorksheetDoc[] {
  const worksheets = Array.isArray(doc.worksheets) ? doc.worksheets : [];
  const tabs = worksheets.map((sheet, index) => {
    const name = typeof sheet?.name === 'string' && sheet.name.trim() ? sheet.name.trim() : `Sheet ${index + 1}`;
    const style = sheet?.style && typeof sheet.style === 'object' && !Array.isArray(sheet.style)
      ? Object.fromEntries(Object.entries(sheet.style).filter(([, value]) => typeof value === 'string'))
      : undefined;
    const columns = Array.isArray(sheet?.columns)
      ? sheet.columns.map(column => ({
        title: typeof column?.title === 'string' ? column.title : undefined,
        width: typeof column?.width === 'string' || typeof column?.width === 'number' ? column.width : undefined,
      }))
      : undefined;
    return { name, cells: normalizeSheetCells(sheet?.cells), style, columns };
  });

  if (tabs.length) return tabs;
  return [{ name: 'Sheet 1', cells: normalizeSheetCells(doc.cells) }];
}

function createSheetWorksheetOptions(sheet: SheetWorksheetDoc, locked: boolean, index = 0): jspreadsheet.WorksheetOptions {
  const cells = normalizeSheetCells(sheet.cells);
  const colCount = Math.max(1, cells[0]?.length || 1, sheet.columns?.length || 0);
  const rowCount = cells.length;
  const columns: jspreadsheet.Column[] = Array.from({ length: colCount }, (_, columnIndex) => {
    const savedColumn = sheet.columns?.[columnIndex];
    return {
      type: 'text',
      title: savedColumn?.title,
      width: savedColumn?.width ?? 150,
      wordWrap: true,
    };
  });

  return {
    worksheetName: sheet.name || `Sheet ${index + 1}`,
    data: cells as SheetCellValue[][],
    columns,
    style: sheet.style,
    minDimensions: [colCount, rowCount],
    tableOverflow: true,
    tableWidth: '100%',
    tableHeight: 'calc(100vh - 226px)',
    filters: true,
    search: true,
    editable: !locked,
    allowInsertColumn: !locked,
    allowInsertRow: !locked,
    allowDeleteColumn: !locked,
    allowDeleteRow: !locked,
    allowRenameColumn: !locked,
    columnDrag: !locked,
    rowDrag: !locked,
    columnSorting: true,
    textOverflow: true,
  };
}

function normalizeSheetCells(cells: string[][] | undefined): string[][] {
  const source = Array.isArray(cells) && cells.length ? cells : [['']];
  const colCount = Math.max(1, ...source.map(row => Array.isArray(row) ? row.length : 0));
  return source.map(row => {
    const safeRow = Array.isArray(row) ? row : [];
    return Array.from({ length: colCount }, (_, index) => String(safeRow[index] ?? ''));
  });
}

function createBlankSheetCells(rows = 15, columns = 8): string[][] {
  return Array.from({ length: rows }, () => Array.from({ length: columns }, () => ''));
}

function updateSheetStats(instance: SheetWorksheet): void {
  const cells = sheetCellsFromWorksheet(instance);
  const rowCount = cells.length;
  const colCount = cells[0]?.length || 1;
  const rowStat = $('sheet-row-count');
  const columnStat = $('sheet-column-count');
  if (rowStat) rowStat.textContent = String(rowCount);
  if (columnStat) columnStat.textContent = String(colCount);
}

function syncActiveSheetFromSpreadsheet(): SheetWorksheet | null {
  if (!sheetSpreadsheet && sheetHost) {
    sheetSpreadsheet = (sheetHost as jspreadsheet.JspreadsheetInstanceElement).spreadsheet || null;
  }
  if (sheetSpreadsheet) {
    const activeIndex = sheetSpreadsheet.getWorksheetActive();
    sheetWorksheet = sheetSpreadsheet.worksheets[activeIndex] || sheetWorksheet;
  }
  if (sheetWorksheet) updateSheetStats(sheetWorksheet);
  return sheetWorksheet;
}

function handleSheetSearch(resetWhenEmpty = false): void {
  const worksheet = syncActiveSheetFromSpreadsheet();
  if (!worksheet) return;
  const query = (($('sheet-search-input') as HTMLInputElement | null)?.value || '').trim();
  if (query) worksheet.search(query);
  else if (resetWhenEmpty) worksheet.resetSearch();
}

function sheetToolbarContent(item: SheetToolbarItem): string | undefined {
  const content = (item as { content?: unknown }).content;
  return typeof content === 'string' ? content : undefined;
}

function isSheetToolbarDivider(item: SheetToolbarItem): boolean {
  return (item as { type?: unknown }).type === 'divisor';
}

function customizeSheetToolbar(defaultToolbar: SheetToolbarItem[] | SheetToolbarConfig): SheetToolbarItem[] | SheetToolbarConfig {
  const defaultItems = Array.isArray(defaultToolbar)
    ? defaultToolbar
    : Array.isArray(defaultToolbar.items)
      ? defaultToolbar.items
      : [];
  const toolbar = defaultItems.flatMap(item => {
    const content = sheetToolbarContent(item);
    if (content === 'fullscreen') return [];
    if (content === 'web') {
      return [{
        ...item,
        tooltip: 'Merge cells',
        onclick: () => {
          void openSheetMergeModal();
        },
      } as SheetToolbarItem];
    }
    return [item];
  });

  const items = toolbar.filter((item, index, allItems) => {
    if (!isSheetToolbarDivider(item)) return true;
    if (index === 0 || index === allItems.length - 1) return false;
    return !isSheetToolbarDivider(allItems[index - 1]) && !isSheetToolbarDivider(allItems[index + 1]);
  });

  return Array.isArray(defaultToolbar) ? items : { ...defaultToolbar, items };
}

function sheetContextMenuTitle(item: SheetContextMenuItem): string {
  return String(item.title || '').trim().toLowerCase();
}

function normalizeSheetColumnIndex(value: string | number | null): number | null {
  const index = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(index) && index >= 0 ? index : null;
}

function isSheetColumnStructureMenuItem(item: SheetContextMenuItem): boolean {
  const title = sheetContextMenuTitle(item);
  return title === 'insert a new column before'
    || title === 'insert a new column after'
    || title === 'delete selected columns';
}

function createSheetFilterCell(columnIndex: number, worksheet: SheetWorksheet): HTMLTableCellElement {
  const cell = document.createElement('td');
  cell.innerHTML = '&nbsp;';
  cell.className = 'jss_column_filter';
  cell.setAttribute('data-x', String(columnIndex));
  if (worksheet.options.columns?.[columnIndex]?.type === 'hidden') {
    cell.style.display = 'none';
  }
  return cell;
}

function syncSheetFilterRow(worksheet: SheetWorksheet): void {
  if (!worksheet.filter) return;

  const columnCount = worksheet.options.columns?.length || worksheet.headers?.length || 0;
  const expectedCellCount = columnCount + 1;

  while (worksheet.filter.children.length > expectedCellCount) {
    worksheet.filter.lastElementChild?.remove();
  }

  while (worksheet.filter.children.length < expectedCellCount) {
    worksheet.filter.appendChild(createSheetFilterCell(worksheet.filter.children.length - 1, worksheet));
  }

  const corner = worksheet.filter.children[0] as HTMLTableCellElement | undefined;
  corner?.removeAttribute('data-x');
  corner?.classList.remove('jss_column_filter');

  for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
    const cell = worksheet.filter.children[columnIndex + 1] as HTMLTableCellElement | undefined;
    if (!cell) continue;
    cell.classList.add('jss_column_filter');
    cell.setAttribute('data-x', String(columnIndex));
    cell.style.display = worksheet.options.columns?.[columnIndex]?.type === 'hidden' ? 'none' : '';
    if (!cell.innerHTML.trim()) cell.innerHTML = '&nbsp;';
  }

  worksheet.filters.length = columnCount;
}

function scheduleSheetFilterRowSync(worksheet: SheetWorksheet): void {
  setTimeout(() => {
    syncSheetFilterRow(worksheet);
  }, 0);
}

function repairSheetColumnStructure(worksheet: SheetWorksheet): void {
  setTimeout(() => {
    syncSheetFilterRow(worksheet);
    updateSheetStats(worksheet);
    scheduleSheetSave(worksheet);
  }, 0);
}

function isSheetTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return !!target.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]');
}

function clearSelectedSheetCells(worksheet: SheetWorksheet): void {
  const selectedCells = worksheet.highlighted
    .map(cell => cell.element)
    .filter((cell): cell is HTMLTableCellElement => cell instanceof HTMLTableCellElement);

  if (selectedCells.length) {
    worksheet.setValue(selectedCells, '');
    return;
  }

  const selected = worksheet.selectedCell?.map(value => Number(value));
  if (!selected || selected.some(value => !Number.isFinite(value))) return;
  const [x1, y1, x2, y2] = selected;
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  const updates: Array<{ x: number; y: number; value: SheetCellValue }> = [];

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) {
      updates.push({ x, y, value: '' });
    }
  }

  if (updates.length) worksheet.setValue(updates);
}

function handleSheetDeleteKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Backspace' && event.key !== 'Delete') return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (state.currentPage?.file_type !== 'sheet' || state.currentPage?.locked) return;
  if (isSheetTextEditingTarget(event.target)) return;

  const worksheet = syncActiveSheetFromSpreadsheet();
  if (!worksheet?.selectedCell || worksheet.edition) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  clearSelectedSheetCells(worksheet);
}

function renameSheetColumn(worksheet: SheetWorksheet, columnIndex: number): void {
  if (state.currentPage?.locked) return;
  if (columnIndex < 0 || columnIndex >= (worksheet.options.columns?.length || 0)) return;

  const currentHeader = worksheet.getHeader(columnIndex) || sheetColumnName(columnIndex);
  openTextInputModal('Rename Column', currentHeader, value => {
    const nextName = value.trim();
    if (!nextName || nextName === currentHeader) return;
    worksheet.setHeader(columnIndex, nextName);
    syncSheetFilterRow(worksheet);
    updateSheetStats(worksheet);
    scheduleSheetSave(worksheet);
  });
}

function customizeSheetContextMenu(
  worksheet: SheetWorksheet,
  colIndex: string | number | null,
  _rowIndex: string | number | null,
  _event: PointerEvent,
  items: SheetContextMenuItem[],
  role: SheetContextMenuRole,
): SheetContextMenuItem[] | null | undefined {
  if (role !== 'header') return items;

  const columnIndex = normalizeSheetColumnIndex(colIndex);
  return items.map(item => {
    if (sheetContextMenuTitle(item) === 'rename this column') {
      return {
        ...item,
        onclick: () => {
          if (columnIndex !== null) renameSheetColumn(worksheet, columnIndex);
        },
      };
    }

    if (!isSheetColumnStructureMenuItem(item) || typeof item.onclick !== 'function') return item;
    const originalOnClick = item.onclick;
    return {
      ...item,
      onclick: (instance, event) => {
        originalOnClick(instance, event);
        repairSheetColumnStructure(worksheet);
      },
    };
  });
}

function bindSheetTabRename(): void {
  if (!sheetHost) return;
  const tabs = sheetHost.querySelectorAll<HTMLElement>(
    ':scope > .jtabs-headers-container .jtabs-headers > div:not(.jtabs-border)',
  );
  tabs.forEach((tab, index) => {
    if (tab.dataset.ykRenameReady === 'true') return;
    tab.dataset.ykRenameReady = 'true';
    tab.title = 'Double-click to rename';
    tab.addEventListener('dblclick', event => {
      event.preventDefault();
      event.stopPropagation();
      renameSheetAt(index);
    });
  });
}

function refreshSheetTabBorder(index?: number): void {
  const tabs = (sheetHost as (HTMLDivElement & {
    tabs?: { setBorder?: (tabIndex: number) => void; getActive?: () => number | false };
  }) | null)?.tabs;
  const activeIndex = typeof index === 'number'
    ? index
    : typeof tabs?.getActive === 'function'
      ? tabs.getActive()
      : sheetSpreadsheet?.getWorksheetActive();
  if (typeof activeIndex !== 'number') return;
  tabs?.setBorder?.(activeIndex);
  setTimeout(() => tabs?.setBorder?.(activeIndex), 80);
}

function renameSheetAt(index?: number): void {
  if (state.currentPage?.locked) return;
  const spreadsheet = sheetSpreadsheet || syncActiveSheetFromSpreadsheet()?.parent;
  if (!spreadsheet) return;
  const sheetIndex = typeof index === 'number' ? index : spreadsheet.getWorksheetActive();
  const worksheet = spreadsheet.worksheets[sheetIndex];
  if (!worksheet) return;
  const currentName = worksheet.options.worksheetName || `Sheet ${sheetIndex + 1}`;

  openTextInputModal('Rename Sheet', currentName, value => {
    const nextName = value.trim();
    if (!nextName || nextName === currentName) return;
    worksheet.options.worksheetName = nextName;
    const tab = sheetHost?.querySelectorAll<HTMLElement>(
      ':scope > .jtabs-headers-container .jtabs-headers > div:not(.jtabs-border)',
    )[sheetIndex];
    const label = tab?.querySelector('div') || tab;
    if (label) label.textContent = nextName;
    refreshSheetTabBorder(sheetIndex);
    scheduleSheetSave(worksheet);
  });
}

function sheetColumnName(index: number): string {
  let column = '';
  let current = index + 1;
  while (current > 0) {
    const remainder = (current - 1) % 26;
    column = String.fromCharCode(65 + remainder) + column;
    current = Math.floor((current - remainder - 1) / 26);
  }
  return column;
}

function sheetCellName(column: number, row: number): string {
  return `${sheetColumnName(column)}${row + 1}`;
}

async function openSheetMergeModal(): Promise<void> {
  const worksheet = syncActiveSheetFromSpreadsheet();
  if (!worksheet || state.currentPage?.locked) return;
  const selected = worksheet.selectedCell;
  if (!selected) {
    showToast('Select a range before merging.', 'error');
    return;
  }

  const coords = selected.map(value => Number(value));
  if (coords.some(value => !Number.isFinite(value))) return;
  const [x1, y1, x2, y2] = coords;
  const left = Math.min(x1, x2);
  const right = Math.max(x1, x2);
  const top = Math.min(y1, y2);
  const bottom = Math.max(y1, y2);
  const colspan = right - left + 1;
  const rowspan = bottom - top + 1;
  const cellName = sheetCellName(left, top);

  if (colspan <= 1 && rowspan <= 1) {
    const anchor = worksheet.records[top]?.[left]?.element;
    if (anchor?.getAttribute('data-merged')) {
      worksheet.removeMerge(cellName);
      scheduleSheetSave(worksheet);
    }
    return;
  }

  const confirmed = await showSheetMergeDialog();
  if (!confirmed) return;
  worksheet.setMerge(cellName, colspan, rowspan);
  scheduleSheetSave(worksheet);
}

function showSheetMergeDialog(): Promise<boolean> {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'diagram-modal-backdrop sheet-modal-backdrop';
    const modal = document.createElement('div');
    modal.className = 'diagram-modal sheet-confirm-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const heading = document.createElement('h3');
    heading.textContent = 'Merge cells?';
    const message = document.createElement('p');
    message.textContent = 'The merged cells will retain the value from the top-left cell only.';

    const actions = document.createElement('div');
    actions.className = 'diagram-modal-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn btn-sm btn-ghost';
    cancel.textContent = 'Cancel';
    const merge = document.createElement('button');
    merge.type = 'button';
    merge.className = 'btn btn-sm btn-primary';
    merge.textContent = 'Merge';

    function close(result: boolean): void {
      backdrop.remove();
      resolve(result);
    }

    backdrop.addEventListener('mousedown', event => {
      if (event.target === backdrop) close(false);
    });
    cancel.addEventListener('click', () => close(false));
    merge.addEventListener('click', () => close(true));
    actions.append(cancel, merge);
    modal.append(heading, message, actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    merge.focus();
  });
}

function sheetCellsFromWorksheet(instance: SheetWorksheet): string[][] {
  const raw = instance.getData(false, true);
  return normalizeSheetCells(raw.map(row => row.map(value => value == null ? '' : String(value))));
}

function sheetColumnsFromWorksheet(instance: SheetWorksheet): SheetColumnDoc[] {
  return (instance.options.columns || []).map(column => ({
    title: typeof column.title === 'string' ? column.title : undefined,
    width: column.width,
  }));
}

function sheetDocFromSpreadsheet(spreadsheet: SheetSpreadsheet): SheetDoc {
  const worksheets = spreadsheet.worksheets.map((worksheet, index) => {
    const style = worksheet.getStyle();
    const tab: SheetWorksheetDoc = {
      name: worksheet.options.worksheetName || `Sheet ${index + 1}`,
      cells: sheetCellsFromWorksheet(worksheet),
    };
    const columns = sheetColumnsFromWorksheet(worksheet);
    if (columns.some(column => column.title || column.width !== undefined)) tab.columns = columns;
    if (style && typeof style === 'object' && !Array.isArray(style) && Object.keys(style).length) {
      tab.style = style as Record<string, string>;
    }
    return tab;
  });

  return {
    cells: worksheets[0]?.cells || [['']],
    worksheets,
  };
}

function scheduleSheetSave(instance: SheetWorksheet): void {
  if (!sheetPageId || state.currentPage?.locked) return;
  if (sheetSaveTimer) clearTimeout(sheetSaveTimer);
  const pageId = sheetPageId;
  sheetSaveTimer = setTimeout(() => {
    sheetSaveTimer = undefined;
    void saveSheetFromInstance(pageId, instance);
  }, 180);
}

async function saveSheetFromInstance(pageId: string, instance: SheetWorksheet): Promise<void> {
  const doc = sheetDocFromSpreadsheet(sheetSpreadsheet || instance.parent);
  const content = JSON.stringify(doc, null, 2);
  if (state.currentPageId === pageId) showSavingState();
  try {
    await api.updatePage(pageId, { content });
    if (state.currentPage?.id === pageId) state.currentPage.content = content;
    if (state.currentPageId === pageId) showSavedState();
  } catch (err) {
    if (state.currentPageId === pageId) {
      showToast('Save failed: ' + (err as Error).message, 'error');
      hideSaveState();
    }
  }
}

function addSheetRow(): void {
  const worksheet = syncActiveSheetFromSpreadsheet();
  if (!worksheet || state.currentPage?.locked) return;
  if (worksheet.insertRow(1) !== false) {
    updateSheetStats(worksheet);
    scheduleSheetSave(worksheet);
  }
}

function addSheetColumn(): void {
  const worksheet = syncActiveSheetFromSpreadsheet();
  if (!worksheet || state.currentPage?.locked) return;
  if (worksheet.insertColumn(1) !== false) {
    scheduleSheetFilterRowSync(worksheet);
    updateSheetStats(worksheet);
    scheduleSheetSave(worksheet);
  }
}

function nextSheetName(): string {
  const existing = new Set((sheetSpreadsheet?.worksheets || []).map(worksheet => worksheet.options.worksheetName));
  let index = existing.size + 1;
  let name = `Sheet ${index}`;
  while (existing.has(name)) {
    index += 1;
    name = `Sheet ${index}`;
  }
  return name;
}

function addSheet(): void {
  const worksheet = syncActiveSheetFromSpreadsheet();
  if (!worksheet || state.currentPage?.locked) return;
  worksheet.createWorksheet(createSheetWorksheetOptions({
    name: nextSheetName(),
    cells: createBlankSheetCells(),
  }, false, sheetSpreadsheet?.worksheets.length || 0));
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
function pageFileTypeLabel(fileType: string | undefined): string {
  switch (fileType) {
    case 'diagram': return 'DIAGRAM';
    case 'kanban': return 'TASK BOARD';
    case 'sheet': return 'SPREADSHEET';
    case 'html': return 'HTML';
    case 'md': return 'MD';
    default: return 'MD';
  }
}

function renderPublishedBadge(share: PageShareInfo | undefined): string {
  if (!share?.enabled) return '';
  const label = share.password_protected ? 'Published, password protected' : 'Published';
  return `
    <span class="published-badge" title="${esc(label)}">
      <span class="published-badge-dot" aria-hidden="true"></span>
      <span>Published</span>
    </span>`;
}

function renderFolderView(page: PageNode, container: HTMLElement): void {
  container.className = 'content-area fade-in';
  const children = page.children || [];
  const allPages = state.pages;
  const canAddChildFolder = canCreateFolderInParent(page.id, allPages);
  const roots = allPages.filter(p => !p.parent_id);
  const rootIdx = roots.findIndex(p => p.id === page.id);
  const sectionNum = rootIdx >= 0 ? String(rootIdx + 1).padStart(2, '0') : (page.num || '—');
  const displayName = page.display_name || page.name;

  container.innerHTML = `
    <div class="folder-index">
      <div class="folder-header">
        <div class="folder-title-group">
          ${rootIdx >= 0 ? `<div class="folder-num">SECTION ${sectionNum}</div>` : ''}
          <h1 class="folder-title" style="margin:0">${esc(displayName)}</h1>
          <p class="folder-meta">${children.length + (page.assets?.length || 0)} item${(children.length + (page.assets?.length || 0)) !== 1 ? 's' : ''}</p>
        </div>
        <div class="folder-actions">
          <button class="btn btn-sm btn-ghost" onclick="openNewPageModal('page','${page.id}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 5 3 H 13 L 18 8 V 21 H 5 Z"/><path d="M 13 3 V 8 H 18"/><path d="M 11.5 16 H 14.5"/><path d="M 13 14.5 V 17.5"/></svg> Add Page</button>
          ${canAddChildFolder ? `<button class="btn btn-sm btn-ghost" onclick="openNewPageModal('folder','${page.id}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 3 7 V 19 H 21 V 9 H 11 L 9 7 H 3 Z"/></svg> Add Folder</button>` : ''}
          <button class="btn btn-sm btn-ghost" onclick="openNewPageModal('image')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path fill="currentColor" stroke="none" d="M 16 8 Q 16.7 9.7 18.5 10.2 Q 16.7 10.7 16 12.5 Q 15.3 10.7 13.5 10.2 Q 15.3 9.7 16 8 Z"/><path d="M 4 17 L 9 13 L 13 16 L 17 13"/></svg> Add Image</button>
        </div>
      </div>

      ${renderPriorityTodoSection(page)}

      <div class="folder-search-bar">
        <div class="folder-search-wrap">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="6"/><path d="M 15.5 15.5 L 20 20"/></svg>
          <input type="text" id="folder-search" class="folder-search-input" placeholder="Filter pages and files…" autocomplete="off">
          <button class="folder-search-clear" id="folder-search-clear" style="display:none" title="Clear">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M 6 6 L 18 18"/><path d="M 6 18 L 18 6"/></svg>
          </button>
        </div>
        <span class="folder-search-count" id="folder-search-count"></span>
      </div>

      ${children.length ? (() => {
      const folders = children.filter(c => c.type === 'folder');
      const mdPages = children.filter(c => c.type !== 'folder' && (c.file_type || 'md') === 'md');
      const htmlPages = children.filter(c => c.type !== 'folder' && c.file_type === 'html');
      const toolPages = children.filter(c => c.type !== 'folder' && (
        c.file_type === 'diagram' || c.file_type === 'kanban' || c.file_type === 'sheet'
      ));

      const renderChildCard = (child: PageNode) => {
        const childName = child.display_name || child.name;
        const ext = child.file_type || '';
        return `
        <div class="child-card" data-page-id="${child.id}" data-filter-name="${esc(childName.toLowerCase())}" onclick="navigateTo('${child.id}')">
          <div class="child-card-icon ${child.type === 'folder' ? 'folder' : ext}">
            ${child.type === 'folder'
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 3 7 V 19 H 21 V 9 H 11 L 9 7 H 3 Z"/></svg>`
            : ext === 'html'
              ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 6 3 H 14 L 19 8 V 21 H 6 Z"/><path d="M 14 3 V 8 H 19"/><path d="M 9 12 H 16"/><path d="M 9 15 H 13"/></svg>`
              : ext === 'diagram'
                ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="6" height="6" rx="1.5"/><rect x="14" y="14" width="6" height="6" rx="1.5"/><path d="M 10 7 H 13 C 15 7 16 8 16 10 V 14"/></svg>`
                : ext === 'kanban'
                  ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="4" height="16" rx="1.5"/><rect x="10" y="4" width="4" height="10" rx="1.5"/><rect x="16" y="4" width="4" height="13" rx="1.5"/></svg>`
                  : ext === 'sheet'
                    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M 4 10 H 20"/><path d="M 4 15 H 20"/><path d="M 10 4 V 20"/><path d="M 15 4 V 20"/></svg>`
                    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M 6 3 H 14 L 19 8 V 21 H 6 Z"/><path d="M 14 3 V 8 H 19"/><path d="M 9 12 H 16"/><path d="M 9 15 H 16"/><path d="M 9 18 H 13"/></svg>`}
          </div>
          <div class="child-card-name">${esc(childName)}</div>
          <div class="child-card-meta">${child.type === 'folder' ? `${(state.pages.filter(p => p.parent_id === child.id).length + ((child as any).asset_count || 0))} items` : pageFileTypeLabel(ext)}</div>
          ${renderPublishedBadge(child.share)}
          <button class="child-card-menu-btn" onclick="openChildCardMenu('${child.id}', event)" title="Actions" aria-label="Actions"><svg viewBox="0 0 24 24" fill="none" width="16" height="16"><circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/></svg></button>
        </div>`;
      };

      const section = (label: string, items: PageNode[]) => `
      <div class="folder-section">
        <div class="section-heading">${label} · ${items.length}</div>
        <div class="children-grid">${items.map(renderChildCard).join('')}</div>
      </div>`;

      return [
        folders.length ? section('Folders', folders) : '',
        mdPages.length ? section('Markdown', mdPages) : '',
        htmlPages.length ? section('HTML', htmlPages) : '',
        toolPages.length ? section('Tools', toolPages) : '',
      ].join('');
    })() : `
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
  setupPriorityTodoDragAndDrop(container);

  // Wire up the folder filter input
  const folderSearch = document.getElementById('folder-search') as HTMLInputElement | null;
  const folderSearchClear = document.getElementById('folder-search-clear') as HTMLButtonElement | null;
  const folderSearchCount = document.getElementById('folder-search-count') as HTMLElement | null;

  function applyFolderFilter(): void {
    if (!folderSearch) return;
    const q = folderSearch.value.toLowerCase().trim();
    if (folderSearchClear) folderSearchClear.style.display = q ? '' : 'none';

    let visible = 0;
    let total = 0;

    container.querySelectorAll<HTMLElement>('[data-filter-name]').forEach(card => {
      const name = card.dataset.filterName ?? '';
      const show = !q || name.includes(q);
      card.style.display = show ? '' : 'none';
      total++;
      if (show) visible++;
    });

    // Hide entire folder-section wrappers when all their cards are filtered out
    container.querySelectorAll<HTMLElement>('.folder-section').forEach(section => {
      const hasVisible = Array.from(section.querySelectorAll<HTMLElement>('[data-filter-name]'))
        .some(c => c.style.display !== 'none');
      section.style.display = hasVisible ? '' : 'none';
    });

    if (folderSearchCount) {
      folderSearchCount.textContent = q ? `${visible} of ${total}` : '';
      folderSearchCount.style.color = (q && visible === 0) ? 'var(--tomato)' : '';
    }
  }

  if (folderSearch) {
    folderSearch.addEventListener('input', applyFolderFilter);
    folderSearchClear?.addEventListener('click', () => {
      folderSearch.value = '';
      folderSearch.focus();
      applyFolderFilter();
    });
  }
}

const PRIORITY_COLUMNS: Array<{ id: Priority; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
];

function renderPriorityTodoSection(page: PageNode): string {
  return `<div id="folder-priority-todos" class="folder-priority-todos">${renderPriorityTodoBoard(page)}</div>`;
}

function renderPriorityTodoBoard(page: PageNode): string {
  const todos = page.priority_todos || [];
  if (!todos.length) {
    return `<div class="folder-todo-empty"><button class="btn btn-sm btn-ghost" onclick="addPriorityTodoBoard()">Add priority to-do list</button></div>`;
  }
  return `<div class="priority-board">
    ${PRIORITY_COLUMNS.map(col => `
      <section class="priority-note priority-${col.id}" data-priority="${col.id}">
        <div class="priority-note-head">
          <span>${col.label}</span>
          <button class="priority-add-btn" onclick="addPriorityTodo('${col.id}')" title="Add ${col.label.toLowerCase()} task" aria-label="Add ${col.label.toLowerCase()} task">
            <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M 12 5 V 19"/><path d="M 5 12 H 19"/></svg>
          </button>
        </div>
        ${todos.filter(t => t.priority === col.id).map(t => `
          <div class="priority-item${t.done ? ' done' : ''}" data-todo-id="${esc(t.id)}" draggable="true">
            <button class="priority-check-btn" onclick="togglePriorityTodo('${t.id}')" title="${t.done ? 'Mark incomplete' : 'Mark complete'}" aria-label="${t.done ? 'Mark incomplete' : 'Mark complete'}">
              ${t.done ? `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M 5 12.5 L 10 17 L 19 7"/></svg>` : ''}
            </button>
            <button type="button" class="priority-text-btn" draggable="false" onclick="editPriorityTodo('${t.id}')" title="Edit task" aria-label="Edit task">${esc(t.text)}</button>
            <button class="priority-delete-btn" onclick="deletePriorityTodo('${t.id}')" title="Delete task" aria-label="Delete task">
              <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M 6 6 L 18 18"/><path d="M 6 18 L 18 6"/></svg>
            </button>
          </div>
        `).join('')}
      </section>
    `).join('')}
  </div>`;
}

async function saveFolderTodos(todos: PriorityTodo[]): Promise<void> {
  if (!state.currentPage || state.currentPage.type !== 'folder') return;
  const pageId = state.currentPage.id;
  state.currentPage.priority_todos = todos;
  refreshPriorityTodoSection();

  const { page } = await api.updateFolderTodos(pageId, todos);
  if (!state.currentPage || state.currentPage.id !== pageId) return;

  const savedTodos = page.priority_todos || todos;
  state.currentPage.priority_todos = savedTodos;
  state.currentPage.updated_at = page.updated_at;

  const pageInList = state.pages.find(p => p.id === pageId);
  if (pageInList) {
    pageInList.priority_todos = savedTodos;
    pageInList.updated_at = page.updated_at;
  }
}

function addPriorityTodoBoard(): void {
  void saveFolderTodos([
    { id: uid('todo'), text: 'First task', priority: 'medium', done: false },
  ]);
}

function openTextInputModal(title: string, initialValue: string, onSubmit: (value: string) => void): void {
  const backdrop = document.createElement('div');
  backdrop.className = 'diagram-modal-backdrop';
  const form = document.createElement('form');
  form.className = 'diagram-modal';
  form.setAttribute('role', 'dialog');
  form.setAttribute('aria-modal', 'true');

  const heading = document.createElement('h3');
  heading.textContent = title;
  const input = document.createElement('input');
  input.value = initialValue;
  input.maxLength = 160;
  const actions = document.createElement('div');
  actions.className = 'diagram-modal-actions';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn btn-sm btn-ghost';
  cancel.textContent = 'Cancel';
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'btn btn-sm btn-primary';
  save.textContent = 'Save';

  function close(): void {
    backdrop.remove();
  }

  backdrop.addEventListener('mousedown', event => {
    if (event.target === backdrop) close();
  });
  cancel.addEventListener('click', close);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const value = input.value.trim();
    if (value) onSubmit(value);
    close();
  });

  actions.append(cancel, save);
  form.append(heading, input, actions);
  backdrop.appendChild(form);
  document.body.appendChild(backdrop);
  window.setTimeout(() => {
    input.focus();
    input.select();
  }, 0);
}

function addPriorityTodo(priority: Priority): void {
  openTextInputModal('Add Task', '', text => {
    void saveFolderTodos([...(state.currentPage?.priority_todos || []), { id: uid('todo'), text, priority, done: false }]);
  });
}

function editPriorityTodo(id: string): void {
  const todos = state.currentPage?.priority_todos || [];
  const todo = todos.find(t => t.id === id);
  if (!todo) return;

  openTextInputModal('Edit Task', todo.text, text => {
    if (text === todo.text) return;
    void saveFolderTodos(todos.map(t => t.id === id ? { ...t, text } : t));
  });
}

function togglePriorityTodo(id: string): void {
  void saveFolderTodos((state.currentPage?.priority_todos || []).map(t => t.id === id ? { ...t, done: !t.done } : t));
}

function deletePriorityTodo(id: string): void {
  void saveFolderTodos((state.currentPage?.priority_todos || []).filter(t => t.id !== id));
}

function movePriorityTodo(id: string, priority: Priority): void {
  const todos = state.currentPage?.priority_todos || [];
  if (!todos.some(t => t.id === id && t.priority !== priority)) return;
  void saveFolderTodos(todos.map(t => t.id === id ? { ...t, priority } : t));
}

function refreshPriorityTodoSection(): void {
  if (!state.currentPage || state.currentPage.type !== 'folder') return;
  const section = document.getElementById('folder-priority-todos');
  if (!section) return;
  section.innerHTML = renderPriorityTodoBoard(state.currentPage);
  setupPriorityTodoDragAndDrop(section);
}

function setupPriorityTodoDragAndDrop(scope: ParentNode = document): void {
  const board = scope instanceof HTMLElement && scope.classList.contains('priority-board')
    ? scope
    : scope.querySelector?.('.priority-board') as HTMLElement | null;
  if (!board) return;

  board.querySelectorAll<HTMLElement>('.priority-item').forEach(item => {
    item.addEventListener('dragstart', event => {
      const todoId = item.dataset.todoId;
      if (!todoId || !event.dataTransfer) return;
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', todoId);
      board.classList.add('is-dragging');
      item.classList.add('is-dragging');
    });
    item.addEventListener('dragend', () => clearPriorityTodoDragState(board));
  });

  board.querySelectorAll<HTMLElement>('.priority-note').forEach(note => {
    note.addEventListener('dragover', event => {
      if (!event.dataTransfer) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      note.classList.add('drag-over');
    });
    note.addEventListener('dragleave', event => {
      const nextTarget = event.relatedTarget;
      if (!(nextTarget instanceof Node) || !note.contains(nextTarget)) {
        note.classList.remove('drag-over');
      }
    });
    note.addEventListener('drop', event => {
      event.preventDefault();
      const todoId = event.dataTransfer?.getData('text/plain');
      const priority = note.dataset.priority;
      clearPriorityTodoDragState(board);
      if (todoId && isPriority(priority)) movePriorityTodo(todoId, priority);
    });
  });
}

function clearPriorityTodoDragState(board: HTMLElement): void {
  board.classList.remove('is-dragging');
  board.querySelectorAll('.priority-item.is-dragging, .priority-note.drag-over')
    .forEach(el => el.classList.remove('is-dragging', 'drag-over'));
}

function isPriority(value: string | undefined): value is Priority {
  return value === 'low' || value === 'medium' || value === 'high';
}

// ── Assets ────────────────────────────────────────────────────────────────────

function renderFileCard(a: Asset): string {
  const ext = (a.original_name.split('.').pop() || '').toUpperCase().slice(0, 4);
  const sizeKb = a.size / 1024;
  const sizeLabel = sizeKb >= 1024 ? `${(sizeKb / 1024).toFixed(1)} MB` : `${sizeKb.toFixed(1)} KB`;
  const clickHandler = isCodeFile(a.original_name)
    ? `openCodeFileEditor('${a.id}','${esc(a.original_name)}','${api.assetUrl(a.id)}')`
    : `window.open('${api.assetUrl(a.id)}','_blank')`;
  return `
    <div class="file-asset-card" data-asset-id="${a.id}" data-ext="${ext.toLowerCase()}" data-filter-name="${esc(a.original_name.toLowerCase())}" onclick="${clickHandler}">
      <div class="file-asset-icon"><span class="file-asset-ext">${ext || 'FILE'}</span></div>
      <div class="file-asset-info">
        <div class="file-asset-name">${esc(a.original_name)}</div>
        <div class="file-asset-meta">${sizeLabel}</div>
        ${renderPublishedBadge(a.share)}
      </div>
      <button class="asset-menu-btn asset-menu-btn--inline" onclick="openAssetCardMenu('${a.id}', event)" title="Actions" aria-label="Actions"><svg viewBox="0 0 24 24" fill="none" width="16" height="16"><circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/></svg></button>
    </div>`;
}

// Friendly display name for a file-extension group heading
const EXT_GROUP_LABEL: Record<string, string> = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel',
  ppt: 'PowerPoint', pptx: 'PowerPoint', rtf: 'Rich Text',
  zip: 'Archives', tar: 'Archives', gz: 'Archives', '7z': 'Archives', rar: 'Archives',
  mp4: 'Video', mov: 'Video', webm: 'Video', mkv: 'Video',
  mp3: 'Audio', wav: 'Audio', m4a: 'Audio', ogg: 'Audio', flac: 'Audio',
  txt: 'Text', csv: 'CSV',
};

function renderAssetsSection(page: PageNode): string {
  const assets = page.assets || [];
  if (!assets.length) return '';

  const imgs = assets.filter((a: Asset) => a.mime_type?.startsWith('image/'));
  const files = assets.filter((a: Asset) => !a.mime_type?.startsWith('image/'));

  // Group non-image files by lowercase extension, sorted alphabetically
  const byExt = new Map<string, Asset[]>();
  for (const a of files) {
    const ext = (a.original_name.split('.').pop() || '').toLowerCase();
    const key = ext || 'other';
    if (!byExt.has(key)) byExt.set(key, []);
    byExt.get(key)!.push(a);
  }
  const extGroups = [...byExt.entries()].sort(([a], [b]) => a.localeCompare(b));

  return `
    <div class="assets-section">
      ${imgs.length ? `
        <div class="folder-section">
          <div class="section-heading">Images &amp; Media · ${imgs.length}</div>
          <div class="asset-grid">
            ${imgs.map(a => `
              <div class="asset-card" data-asset-id="${a.id}" data-filter-name="${esc(a.original_name.toLowerCase())}" onclick="openLightbox('${api.assetUrl(a.id)}','${esc(a.original_name)}')">
                <div class="asset-preview">
                  <img src="${api.assetUrl(a.id)}" alt="${esc(a.original_name)}" loading="lazy">
                </div>
                <div class="asset-info">
	                  <div class="asset-name">${esc(a.original_name)}</div>
	                  <div class="asset-type">${(a.size / 1024).toFixed(1)} KB</div>
	                  ${renderPublishedBadge(a.share)}
	                </div>
                <button class="asset-menu-btn" onclick="openAssetCardMenu('${a.id}', event)" title="Actions" aria-label="Actions"><svg viewBox="0 0 24 24" fill="none" width="16" height="16"><circle cx="5" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="19" cy="12" r="1.5" fill="currentColor"/></svg></button>
              </div>
            `).join('')}
          </div>
        </div>
      ` : ''}
      ${extGroups.map(([ext, group]) => {
    const label = EXT_GROUP_LABEL[ext] ?? ext.toUpperCase();
    return `
        <div class="folder-section">
          <div class="section-heading">${esc(label)} · ${group.length}</div>
          <div class="file-asset-grid">
            ${group.map(renderFileCard).join('')}
          </div>
        </div>`;
  }).join('')}
    </div>
  `;
}

interface CardMenuItem {
  label: string;
  icon?: string;
  href?: string;
  target?: string;
  download?: string;
  danger?: boolean;
  submenu?: CardMenuItem[];
  onClick?: () => void;
}

const SVG_ATTRS = 'xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
const ICON = {
  externalLink: `<svg ${SVG_ATTRS}><path d="M 14 4 H 20 V 10"/><path d="M 20 4 L 12 12"/><path d="M 18 14 V 19 a 1 1 0 0 1 -1 1 H 5 a 1 1 0 0 1 -1 -1 V 7 a 1 1 0 0 1 1 -1 H 10"/></svg>`,
  download: `<svg ${SVG_ATTRS}><path d="M 12 4 V 16"/><path d="M 7 12 L 12 17 L 17 12"/><path d="M 4 20 H 20"/></svg>`,
  copy: `<svg ${SVG_ATTRS}><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M 5 16 V 5 a 2 2 0 0 1 2 -2 H 16"/></svg>`,
  share: `<svg ${SVG_ATTRS}><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M 8.6 10.7 L 15.4 6.3"/><path d="M 8.6 13.3 L 15.4 17.7"/></svg>`,
  trash: `<svg ${SVG_ATTRS}><path d="M 4 7 H 20"/><path d="M 9 4 H 15 V 7"/><path d="M 6 7 V 19 a 2 2 0 0 0 2 2 H 16 a 2 2 0 0 0 2 -2 V 7"/><path d="M 10 11 V 17"/><path d="M 14 11 V 17"/></svg>`,
  pencil: `<svg ${SVG_ATTRS}><path d="M 4 20 L 8 20 L 18 10 L 14 6 L 4 16 Z"/><path d="M 13 7 L 17 11"/></svg>`,
  arrowRight: `<svg ${SVG_ATTRS}><path d="M 4 12 H 20"/><path d="M 14 6 L 20 12 L 14 18"/></svg>`,
  folderMove: `<svg ${SVG_ATTRS}><path d="M 3 7 V 19 H 17 V 9 H 9 L 7 7 H 3 Z"/><path d="M 19 13 H 22"/><path d="M 20 11 L 22 13 L 20 15"/></svg>`,
  plus: `<svg ${SVG_ATTRS}><path d="M 12 5 V 19"/><path d="M 5 12 H 19"/></svg>`,
  fileText: `<svg ${SVG_ATTRS}><path d="M 6 3 H 14 L 19 8 V 21 H 6 Z"/><path d="M 14 3 V 8 H 19"/><path d="M 9 12 H 16"/><path d="M 9 15 H 16"/><path d="M 9 18 H 13"/></svg>`,
  folder: `<svg ${SVG_ATTRS}><path d="M 3 7 V 19 H 21 V 9 H 11 L 9 7 H 3 Z"/></svg>`,
  chevronRight: `<svg ${SVG_ATTRS}><path d="M 9 6 L 15 12 L 9 18"/></svg>`,
  chevronDown: `<svg ${SVG_ATTRS}><path d="M 6 9 L 12 15 L 18 9"/></svg>`,
};

let _activeMenuTrigger: HTMLElement | null = null;
let _hoverSubmenuTimer: ReturnType<typeof setTimeout> | null = null;

type MenuAnchor = HTMLElement | { x: number; y: number };

function renderMenuItems(items: CardMenuItem[]): string {
  return items.map((it, i) => {
    const cls = `floating-card-menu-item${it.danger ? ' danger' : ''}${it.submenu ? ' has-submenu' : ''}`;
    const icon = `<span class="floating-card-menu-icon" aria-hidden="true">${it.icon || ''}</span>`;
    const label = `<span class="floating-card-menu-label">${esc(it.label)}</span>`;
    const arrow = it.submenu
      ? `<span class="floating-card-menu-chevron" aria-hidden="true">${ICON.chevronRight}</span>`
      : '';
    if (it.href) {
      const tgt = it.target ? ` target="${it.target}" rel="noopener"` : '';
      const dl = it.download ? ` download="${esc(it.download)}"` : '';
      return `<a class="${cls}" href="${it.href}"${tgt}${dl} data-idx="${i}">${icon}${label}${arrow}</a>`;
    }
    return `<button class="${cls}" data-idx="${i}" type="button">${icon}${label}${arrow}</button>`;
  }).join('');
}

function positionFloatingMenu(
  menu: HTMLElement,
  anchor: MenuAnchor,
  opts: { preferRight?: boolean } = {},
): void {
  const margin = 8;
  const gap = 6;
  const menuRect = menu.getBoundingClientRect();
  let left: number;
  let top: number;

  if (anchor instanceof HTMLElement) {
    const r = anchor.getBoundingClientRect();
    if (opts.preferRight) {
      // Submenu — place to the right of the parent item.
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

function attachItemHandlers(
  menu: HTMLElement,
  items: CardMenuItem[],
  isSubmenu: boolean,
): void {
  menu.querySelectorAll<HTMLElement>('[data-idx]').forEach(el => {
    const idx = Number(el.dataset.idx);
    const item = items[idx];
    if (!item) return;

    if (item.submenu) {
      const openIt = () => openSubmenu(el, item.submenu!);
      el.addEventListener('mouseenter', () => {
        if (_hoverSubmenuTimer) clearTimeout(_hoverSubmenuTimer);
        _hoverSubmenuTimer = setTimeout(openIt, 80);
      });
      el.addEventListener('mouseleave', () => {
        if (_hoverSubmenuTimer) { clearTimeout(_hoverSubmenuTimer); _hoverSubmenuTimer = null; }
      });
      el.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); openIt(); });
    } else {
      el.addEventListener('click', () => {
        closeCardMenu();
        item.onClick?.();
      });
      // Hovering a non-submenu item closes any open submenu in the parent menu.
      if (!isSubmenu) {
        el.addEventListener('mouseenter', () => closeSubmenu());
      }
    }
  });
}

function openCardMenu(anchor: MenuAnchor, items: CardMenuItem[]): void {
  const menu = $('floating-card-menu');
  if (!menu) return;

  const anchorEl = anchor instanceof HTMLElement ? anchor : null;
  if (anchorEl && _activeMenuTrigger === anchorEl) { closeCardMenu(); return; }
  closeCardMenu();

  menu.innerHTML = renderMenuItems(items);
  attachItemHandlers(menu, items, false);

  if (anchorEl) {
    anchorEl.classList.add('active');
    _activeMenuTrigger = anchorEl;
  }

  menu.classList.add('open');
  positionFloatingMenu(menu, anchor);
}

function openSubmenu(parentItem: HTMLElement, items: CardMenuItem[]): void {
  const sub = $('floating-card-submenu');
  if (!sub) return;
  // Highlight the parent item while submenu is open
  const menu = $('floating-card-menu');
  menu?.querySelectorAll('.floating-card-menu-item.has-submenu.submenu-open')
    .forEach(el => el.classList.remove('submenu-open'));
  parentItem.classList.add('submenu-open');

  sub.innerHTML = renderMenuItems(items);
  attachItemHandlers(sub, items, true);
  sub.classList.add('open');
  positionFloatingMenu(sub, parentItem, { preferRight: true });
}

function closeSubmenu(): void {
  $('floating-card-submenu')?.classList.remove('open');
  if (_hoverSubmenuTimer) { clearTimeout(_hoverSubmenuTimer); _hoverSubmenuTimer = null; }
  document.querySelectorAll('.floating-card-menu-item.submenu-open')
    .forEach(el => el.classList.remove('submenu-open'));
}

function closeCardMenu(): void {
  closeSubmenu();
  $('floating-card-menu')?.classList.remove('open');
  if (_activeMenuTrigger) {
    _activeMenuTrigger.classList.remove('active');
    _activeMenuTrigger = null;
  }
}

function openAssetCardMenu(assetId: string, ev: MouseEvent): void {
  ev.stopPropagation();
  const a = state.currentPage?.assets?.find(x => x.id === assetId);
  if (!a) return;
  const url = api.assetUrl(a.id);
  openCardMenu(ev.currentTarget as HTMLElement, [
    { label: 'Open in new tab', icon: ICON.externalLink, href: url, target: '_blank' },
    { label: 'Download', icon: ICON.download, href: url, download: a.original_name },
    { label: 'Share...', icon: ICON.share, onClick: () => openAssetShareModal(a.id) },
    { label: 'Copy URL', icon: ICON.copy, onClick: () => copyToClipboard(url) },
    { label: 'Move to…', icon: ICON.folderMove, onClick: () => openMoveModal('asset', a.id) },
    { label: 'Delete', icon: ICON.trash, danger: true, onClick: () => deleteAsset(a.id) },
  ]);
}

function openChildCardMenu(pageId: string, ev: MouseEvent): void {
  ev.stopPropagation();
  const c = state.pages.find(p => p.id === pageId);
  if (!c) return;
  const name = c.display_name || c.name;
  openCardMenu(ev.currentTarget as HTMLElement, [
    { label: 'Open', icon: ICON.arrowRight, onClick: () => navigateTo(c.id) },
    { label: 'Rename', icon: ICON.pencil, onClick: () => renamePagePrompt(c.id, name) },
    { label: 'Move to…', icon: ICON.folderMove, onClick: () => openMoveModal('page', c.id) },
    { label: 'Delete', icon: ICON.trash, danger: true, onClick: () => deletePageConfirm(c.id, name) },
  ]);
}

function renderUploadZone(pageId: string): string {
  return `
    <div class="assets-section">
      <div class="section-heading">Upload Files</div>
      <div class="upload-zone" id="upload-zone-${pageId}" onclick="triggerUpload('${pageId}')">
        <div class="upload-zone-icon">📎</div>
        <div class="upload-zone-text">Drop files here or click to upload</div>
        <div class="upload-zone-hint">.md, .html, and tool JSON files become pages · other files attach as assets</div>
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

  const allFiles = Array.from(files);

  // Separate page files from regular assets.
  const docFiles = allFiles.filter(isPageUploadFile);
  const assetFiles = allFiles.filter(f => !isPageUploadFile(f));

  // Determine parent folder — if we're viewing a folder, import into it
  const currentPage = state.pages.find(p => p.id === pageId);
  const parentId = currentPage?.type === 'folder' ? pageId : (currentPage?.parent_id || null);

  // Import document files as pages
  if (docFiles.length) {
    showToast(`Importing ${docFiles.length} document(s)…`);
    for (const f of docFiles) {
      try {
        const content = await f.text();
        const baseName = pageUploadBaseName(f.name);
        const fileType = pageUploadFileType(f);

        await api.createPage({
          name: baseName,
          type: 'page',
          file_type: fileType,
          parent_id: parentId,
          content,
        });
      } catch (err) {
        showToast(`Failed to import ${f.name}: ${(err as Error).message}`, 'error');
      }
    }
    await loadPages();
    showToast(`Imported ${docFiles.length} page(s)`);
  }

  // Upload remaining files as assets
  if (assetFiles.length) {
    showToast(`Uploading ${assetFiles.length} file(s)…`);
    const form = new FormData();
    for (const f of assetFiles) form.append('files', f);
    form.append('page_id', pageId);
    try {
      await api.uploadFiles(form);
      showToast('Uploaded!');
      loadStorageUsage();
    } catch (err) {
      showToast('Upload failed: ' + (err as Error).message, 'error');
    }
  }

  await renderPage(pageId);
}

function isPageUploadFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return name.endsWith('.md')
    || name.endsWith('.html')
    || name.endsWith('.htm')
    || name.endsWith('.diagram.json')
    || name.endsWith('.kanban.json')
    || name.endsWith('.sheet.json');
}

function pageUploadBaseName(name: string): string {
  return name.replace(/\.(md|html|htm|diagram\.json|kanban\.json|sheet\.json)$/i, '');
}

function pageUploadFileType(file: File): NonNullable<PageNode['file_type']> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.diagram.json')) return 'diagram';
  if (name.endsWith('.kanban.json')) return 'kanban';
  if (name.endsWith('.sheet.json')) return 'sheet';
  return name.endsWith('.md') ? 'md' : 'html';
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
    loadStorageUsage();
    if (state.currentPageId) await renderPage(state.currentPageId);
  } catch (err) {
    showToast('Delete failed: ' + (err as Error).message, 'error');
  }
}

// ── Create page/folder modal ──────────────────────────────────────────────────
let _ctxFolderId: string | null = null;

function openNewPageModal(defaultType: 'page' | 'folder' | 'image' = 'page', ctxFolderId?: string): void {
  _ctxFolderId = ctxFolderId || null;

  // If AI not configured, block opening the AI Image type
  if (defaultType === 'image' && !state.aiEnabled) defaultType = 'page';
  if (defaultType === 'folder' && _ctxFolderId && !canCreateFolderInParent(_ctxFolderId, state.pages)) {
    defaultType = 'page';
  }

  // Reflect AI availability on the AI Image type-option
  const imageOption = document.getElementById('type-option-image');
  if (imageOption) {
    imageOption.style.opacity = state.aiEnabled ? '' : '0.4';
    imageOption.style.pointerEvents = state.aiEnabled ? '' : 'none';
    imageOption.title = state.aiEnabled ? '' : 'Configure an AI profile first';
  }

  const folderOption = document.querySelector<HTMLElement>('.type-option[data-type="folder"]');
  const canUseFolderType = !_ctxFolderId || canCreateFolderInParent(_ctxFolderId, state.pages);
  if (folderOption) {
    folderOption.style.opacity = canUseFolderType ? '' : '0.4';
    folderOption.style.pointerEvents = canUseFolderType ? '' : 'none';
    folderOption.title = canUseFolderType ? '' : 'Folders can only be nested one level deep';
  }

  $('new-page-overlay').classList.add('open');
  ($('new-page-type') as HTMLSelectElement).value = defaultType;
  updateTypeOptions(defaultType);
  ($('new-page-name') as HTMLInputElement).value = '';
  ($('new-page-ai-prompt') as HTMLInputElement).value = '';
  ($('new-page-image-prompt') as HTMLTextAreaElement).value = '';
  $('new-page-ai-section').style.display = 'none';
  $('new-page-image-section').style.display = defaultType === 'image' ? '' : 'none';
  populateParentSelect(defaultType);
  // Reset template selection and refresh the list (lazy-load on every open
  // so newly-saved templates appear immediately).
  ($('new-page-template') as HTMLSelectElement).value = '';
  populateNewPageTemplateSelect();
  void loadTemplates();
  ($('new-page-name') as HTMLInputElement).focus();
}

function populateParentSelect(type: string): void {
  const select = $('new-page-parent') as HTMLSelectElement;
  const folders = state.pages.filter(p => p.type === 'folder');

  // Build a child map for depth-first traversal
  const childMap = new Map<string, typeof folders>();
  folders.forEach(f => {
    const key = f.parent_id || '';
    if (!childMap.has(key)) childMap.set(key, []);
    childMap.get(key)!.push(f);
  });

  select.innerHTML = '<option value="">— Root level —</option>';

  function addOptions(parentId: string, depth: number): void {
    const children = childMap.get(parentId) || [];
    children.forEach(f => {
      const opt = document.createElement('option');
      opt.value = f.id;
      const indent = depth === 0 ? '' : '  '.repeat(depth) + '└ ';
      opt.textContent = indent + (f.display_name || f.name);
      select.appendChild(opt);
      addOptions(f.id, depth + 1);
    });
  }

  addOptions('', 0);

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
  const isImage = type === 'image';
  $('new-page-file-type-row').style.display = (isFolder || isImage) ? 'none' : '';
  $('new-page-parent-row').style.display = (isFolder || isImage) ? 'none' : '';
  $('new-page-ai-section').style.display = 'none';
  $('new-page-image-section').style.display = isImage ? '' : 'none';

  // Templates only apply to .md pages (markdown templates).
  const fileType = ($('new-page-file-type') as HTMLSelectElement).value;
  const showTemplate = !isFolder && !isImage && fileType === 'md';
  $('new-page-template-row').style.display = showTemplate ? '' : 'none';

  // Pre-fill with AI: never shown for folders, only shown for pages when AI enabled
  const showPrefill = !isFolder && !isImage && fileType !== 'diagram' && fileType !== 'kanban' && fileType !== 'sheet' && state.aiEnabled;
  $('new-page-ai-prefill-row').style.display = showPrefill ? '' : 'none';
  if (!showPrefill) $('new-page-ai-section').style.display = 'none';
  // Reset active state when switching types
  const card = $('new-page-ai-prefill-row');
  if (card) { card.classList.remove('active'); card.dataset.active = 'false'; }

  // Update name field placeholder
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
  if (type === 'folder' && _ctxFolderId && !canCreateFolderInParent(_ctxFolderId, state.pages)) {
    showToast('Folders can only be nested one level deep', 'error');
    return;
  }
  ($('new-page-type') as HTMLSelectElement).value = type;
  updateTypeOptions(type);
}

function toggleAiFill(): void {
  const section = $('new-page-ai-section');
  const card = $('new-page-ai-prefill-row'); // the card IS the prefill row
  const isActive = card?.dataset.active === 'true';

  if (isActive) {
    // Deactivate
    section.style.display = 'none';
    if (card) { card.dataset.active = 'false'; card.classList.remove('active'); }
  } else {
    // Activate
    section.style.display = '';
    if (card) { card.dataset.active = 'true'; card.classList.add('active'); }
    ($('new-page-ai-prompt') as HTMLInputElement).focus();
  }
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
    showMascotLoading('Generating image…', 'Yoyo is painting your idea');
    try {
      const page_id = state.currentPageId ?? undefined;
      await api.generateImg({ prompt: imagePrompt, page_id });
      closeNewPageModal();
      if (state.currentPageId) await renderPage(state.currentPageId);
      showToast('Image generated!');
    } catch (err) {
      showToast('Failed: ' + (err as Error).message, 'error');
    } finally {
      hideMascotLoading();
      btn.disabled = false; btn.textContent = 'Create';
    }
    return;
  }

  if (!rawName) { showToast('Please enter a name', 'error'); return; }

  let parentId: string | null = null;
  let finalName = rawName;

  if (type === 'folder') {
    if (_ctxFolderId) {
      if (!canCreateFolderInParent(_ctxFolderId, state.pages)) {
        showToast('Folders can only be nested one level deep', 'error');
        return;
      }
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

    // Template (markdown only) takes precedence over the AI prompt.
    const templateId = type === 'page' && fileType === 'md'
      ? ($('new-page-template') as HTMLSelectElement).value
      : '';
    if (templateId) {
      const tpl = templatesList.find(t => t.id === templateId);
      if (tpl) content = tpl.content;
    } else if (type === 'page' && aiPrompt) {
      showMascotLoading('Generating content…', 'Yoyo is writing your page');
      try {
        const { content: gen } = await api.generate({ prompt: aiPrompt, type: fileType as 'md' | 'html' });
        content = gen;
      } finally {
        hideMascotLoading();
      }
    } else if (type === 'page') {
      content = defaultContentForFileType(fileType);
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
  // Cancel any pending auto-save and tear down the editor before clearing state
  clearTimeout(saveTimer);
  disposeReactToolRoots();
  if (state.wysiwyg) {
    try { state.wysiwyg.destroy(); } catch { /* ignore */ }
    state.wysiwyg = null;
  }

  // Clear the URL hash so hashchange doesn't re-navigate to a deleted page
  history.replaceState(null, '', window.location.pathname);
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
        <button class="btn btn-primary" onclick="openNewPageModal('folder')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;display:inline-block;vertical-align:-2px;margin-right:5px"><path d="M 3 7 V 19 H 21 V 9 H 11 L 9 7 H 3 Z"/></svg>New Folder</button>
        <button class="btn btn-ghost" onclick="openNewPageModal('page')"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;display:inline-block;vertical-align:-2px;margin-right:5px"><path d="M 5 3 H 13 L 18 8 V 21 H 5 Z"/><path d="M 13 3 V 8 H 18"/><path d="M 11.5 16 H 14.5"/><path d="M 13 14.5 V 17.5"/></svg>New Page</button>
      </div>
    </div>
  `;
  const badge = document.getElementById('topbar-badge');
  if (badge) badge.textContent = '';
  const titleEl = document.getElementById('page-title') as HTMLInputElement | null;
  if (titleEl) { titleEl.value = ''; titleEl.disabled = false; }
  const bcParent = document.getElementById('bc-parent');
  if (bcParent) bcParent.textContent = 'yoınko';

  document.getElementById('html-edit-btn')?.classList.add('hidden');
  document.getElementById('lock-page-btn')?.classList.add('hidden');
  document.getElementById('share-page-btn')?.classList.add('hidden');
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

  const oldId = _renameId;
  // Capture paths BEFORE the API call. The id is base64url(path) so any
  // rename of a page/folder produces a NEW id; if the user was viewing the
  // renamed item — or a descendant of it — their state.currentPageId is
  // about to become stale.
  const oldRenamedPath = state.pages.find(p => p.id === oldId)?.path ?? '';
  const viewedOldPath = state.currentPage?.path ?? '';

  try {
    const res = await api.updatePage(oldId, { name: newName });
    const newId = res.page.id;
    const newRenamedPath = res.page.path;

    await loadPages();

    let targetId: string | null = null;
    if (state.currentPageId === oldId) {
      // Viewing the renamed item itself.
      targetId = newId;
    } else if (
      oldRenamedPath
      && newRenamedPath
      && viewedOldPath
      && viewedOldPath.startsWith(oldRenamedPath + '/')
    ) {
      // Viewing a descendant of the renamed folder — remap its path.
      const remapped = newRenamedPath + viewedOldPath.slice(oldRenamedPath.length);
      const target = state.pages.find(p => p.path === remapped);
      if (target) targetId = target.id;
    }

    if (targetId) {
      // Force navigation: navigateTo bails early when ids match.
      state.currentPageId = null;
      await navigateTo(targetId);
    } else if (state.currentPageId && state.pages.find(p => p.id === state.currentPageId)) {
      // Unrelated rename — re-render so any child cards or breadcrumbs
      // referencing the renamed item pick up its new name.
      await renderPage(state.currentPageId);
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

// ── Move (page or asset) ─────────────────────────────────────────────────────
type MoveTarget =
  | { kind: 'page'; id: string; name: string; currentParentId: string | null }
  | { kind: 'asset'; id: string; name: string; currentPageId: string | null };

let _moveTarget: MoveTarget | null = null;

interface MoveOption {
  value: string;          // folder id, or empty string for "Root level"
  shortLabel: string;     // last path segment, shown in the option row
  fullLabel: string;      // full path, shown in the trigger after selection
  depth: number;          // 0 for top-level rows, increments for nesting
  isCurrent?: boolean;    // marks the user's current parent — disabled
}

let _moveSelection: { value: string; label: string } | null = null;

function buildFolderOptionsTree(
  blockedIds: Set<string>,
): Array<{ id: string; shortLabel: string; fullLabel: string; depth: number }> {
  const folders = state.pages.filter(p => p.type === 'folder' && !blockedIds.has(p.id));
  const byParent = new Map<string | null, PageNode[]>();
  for (const f of folders) {
    const key = f.parent_id ?? null;
    const list = byParent.get(key) ?? [];
    list.push(f);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => (a.display_name || a.name).localeCompare(b.display_name || b.name));
  }
  const out: Array<{ id: string; shortLabel: string; fullLabel: string; depth: number }> = [];
  const walk = (parentId: string | null, prefix: string, depth: number): void => {
    const list = byParent.get(parentId) ?? [];
    for (const f of list) {
      const name = f.display_name || f.name;
      const fullPath = prefix ? `${prefix} / ${name}` : name;
      out.push({ id: f.id, shortLabel: name, fullLabel: fullPath, depth });
      walk(f.id, fullPath, depth + 1);
    }
  };
  walk(null, '', 0);
  return out;
}

function renderMovePanel(options: MoveOption[]): void {
  const panel = $('move-target-panel');
  if (!panel) return;
  if (!options.length) {
    panel.innerHTML = `<div class="custom-select-empty">No folders available</div>`;
    return;
  }
  panel.innerHTML = options.map((opt, i) => {
    const indent = `<span class="custom-select-option-indent" style="--depth:${opt.depth * 14}px"></span>`;
    const icon = `<span class="custom-select-option-icon" aria-hidden="true">${ICON.folder}</span>`;
    const badge = opt.isCurrent
      ? `<span class="custom-select-option-current">current</span>`
      : '';
    const disabled = opt.isCurrent ? 'disabled' : '';
    return `<button type="button" class="custom-select-option" data-value="${esc(opt.value)}" data-label="${esc(opt.fullLabel)}" data-idx="${i}" data-depth="${opt.depth}" ${disabled}>${indent}${icon}<span class="custom-select-label">${esc(opt.shortLabel)}</span>${badge}</button>`;
  }).join('');

  panel.querySelectorAll<HTMLButtonElement>('.custom-select-option').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const value = btn.dataset.value || '';
      const label = btn.dataset.label || '';
      _moveSelection = { value, label };
      const labelEl = $('move-target-label');
      labelEl.textContent = label;
      labelEl.classList.remove('placeholder');
      panel.querySelectorAll('.custom-select-option.selected').forEach(el => el.classList.remove('selected'));
      btn.classList.add('selected');
      closeMoveTargetPanel();
    });
  });
}

function positionMoveTargetPanel(): void {
  const wrapper = $('move-target-select');
  if (!wrapper.classList.contains('open')) return;
  const trigger = $('move-target-trigger');
  const panel = $('move-target-panel');

  // Reset before measuring (panel is position:fixed)
  panel.style.top = '0px';
  panel.style.left = '0px';
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

function closeMoveTargetPanel(): void {
  $('move-target-select')?.classList.remove('open');
}

function openMoveModal(kind: 'page' | 'asset', id: string): void {
  closeCardMenu();
  const hint = $('move-item-hint');
  const labelEl = $('move-target-label');
  $('move-target-select').classList.remove('open');
  _moveSelection = null;
  labelEl.textContent = '— Pick a folder —';
  labelEl.classList.add('placeholder');

  const options: MoveOption[] = [];

  if (kind === 'page') {
    const p = state.pages.find(x => x.id === id);
    if (!p) return;
    const itemName = p.display_name || p.name;
    const currentParentId = p.parent_id ?? null;

    // Self + descendants are blocked — can't move into yourself.
    const blocked = new Set<string>([id]);
    const collect = (parentId: string): void => {
      state.pages.forEach(c => {
        if (c.parent_id === parentId && !blocked.has(c.id)) {
          blocked.add(c.id);
          if (c.type === 'folder') collect(c.id);
        }
      });
    };
    collect(id);

    options.push({
      value: '',
      shortLabel: 'Root level',
      fullLabel: 'Root level',
      depth: 0,
      isCurrent: currentParentId === null,
    });
    for (const f of buildFolderOptionsTree(blocked).filter(f => canMovePageToParent(p.id, f.id, state.pages))) {
      options.push({
        value: f.id,
        shortLabel: f.shortLabel,
        fullLabel: f.fullLabel,
        depth: f.depth,
        isCurrent: f.id === currentParentId,
      });
    }

    hint.textContent = `Moving "${itemName}" to a different folder.`;
    _moveTarget = { kind: 'page', id, name: itemName, currentParentId };
  } else {
    const a = state.currentPage?.assets?.find(x => x.id === id);
    if (!a) return;
    const itemName = a.original_name;
    const currentPageId = a.page_id ?? null;

    for (const f of buildFolderOptionsTree(new Set())) {
      options.push({
        value: f.id,
        shortLabel: f.shortLabel,
        fullLabel: f.fullLabel,
        depth: f.depth,
        isCurrent: f.id === currentPageId,
      });
    }

    hint.textContent = `Moving "${itemName}" to a different folder.`;
    _moveTarget = { kind: 'asset', id, name: itemName, currentPageId };
  }

  renderMovePanel(options);
  $('move-item-overlay').classList.add('open');
}

function closeMoveModal(): void {
  $('move-item-overlay').classList.remove('open');
  $('move-target-select').classList.remove('open');
  _moveTarget = null;
  _moveSelection = null;
}

async function submitMove(): Promise<void> {
  const t = _moveTarget;
  if (!t) return;
  if (!_moveSelection) {
    showToast('Pick a destination', 'error');
    return;
  }
  const targetValue = _moveSelection.value;

  // Capture paths BEFORE the API call. A page move changes the id (id is
  // base64url of the path), so if the user is viewing the moved item — or a
  // descendant of it — state.currentPageId is about to become stale and a
  // straight renderPage() would 404 with "Page not found".
  const oldMovedPath = t.kind === 'page'
    ? state.pages.find(p => p.id === t.id)?.path ?? ''
    : '';
  const viewedOldPath = state.currentPage?.path ?? '';

  closeMoveModal();
  try {
    let newMovedPath = '';
    if (t.kind === 'page') {
      const res = await api.movePage(t.id, targetValue || null);
      newMovedPath = res.page.path;
    } else {
      if (!targetValue) { showToast('Pick a destination', 'error'); return; }
      await api.moveAsset(t.id, targetValue);
    }

    await loadPages();

    let targetId: string | null = null;
    if (t.kind === 'page') {
      if (state.currentPageId === t.id) {
        // Viewing the moved item itself — find it at its new path.
        const moved = state.pages.find(p => p.path === newMovedPath);
        if (moved) targetId = moved.id;
      } else if (
        oldMovedPath
        && newMovedPath
        && viewedOldPath
        && viewedOldPath.startsWith(oldMovedPath + '/')
      ) {
        // Viewing a descendant of the moved folder — remap its path.
        const remapped = newMovedPath + viewedOldPath.slice(oldMovedPath.length);
        const target = state.pages.find(p => p.path === remapped);
        if (target) targetId = target.id;
      }
    }

    if (targetId) {
      // Force navigation: navigateTo bails early when ids match.
      state.currentPageId = null;
      await navigateTo(targetId);
    } else if (state.currentPageId && state.pages.find(p => p.id === state.currentPageId)) {
      // Unrelated move (or asset move) — re-render so child cards/breadcrumbs update.
      await renderPage(state.currentPageId);
    } else if (state.currentPageId) {
      // Edge case: current page somehow no longer exists.
      showWelcome();
    }

    showToast('Moved!');
  } catch (err) {
    showToast('Move failed: ' + (err as Error).message, 'error');
  }
}

async function submitDelete(): Promise<void> {
  $('delete-overlay').classList.remove('open');

  // Navigate away immediately if we're on the page being deleted.
  // This clears state.currentPageId + hash BEFORE the API call,
  // so no save/render callbacks can fire against the deleted resource.
  const wasCurrent = state.currentPageId === _deleteId;
  if (wasCurrent) showWelcome();

  // Optimistically remove from local state so any hashchange that fires
  // during loadPages won't try to navigate back to the deleted page.
  state.pages = state.pages.filter(p => p.id !== _deleteId);

  try {
    await api.deletePage(_deleteId);
    await loadPages(); // refresh sidebar with authoritative server list
    showToast('Deleted.');
  } catch (err) {
    showToast('Delete failed: ' + (err as Error).message, 'error');
    await loadPages(); // restore sidebar on failure
  }
}

// ── Sidebar right-click context menu (uses unified floating-card-menu) ───────
function showCtxMenu(e: Event, page: PageNode): void {
  e.preventDefault();
  e.stopPropagation();
  const me = e as MouseEvent;
  const displayName = page.display_name || page.name;

  const items: CardMenuItem[] = [];

  if (page.type === 'page') {
    items.push({ label: 'Open', icon: ICON.arrowRight, onClick: () => navigateTo(page.id) });
  }
  items.push({ label: 'Rename', icon: ICON.pencil, onClick: () => renamePagePrompt(page.id, displayName) });

  if (page.type === 'folder') {
    const addSubmenu: CardMenuItem[] = [
      { label: 'Page', icon: ICON.fileText, onClick: () => openNewPageModal('page', page.id) },
    ];
    if (canCreateFolderInParent(page.id, state.pages)) {
      addSubmenu.push({ label: 'Folder', icon: ICON.folder, onClick: () => openNewPageModal('folder', page.id) });
    }
    items.push({
      label: 'Add…',
      icon: ICON.plus,
      submenu: addSubmenu,
    });
  }

  // Move: pages always; folders only if they have a parent (subfolder).
  // Top-level folders cannot be moved (they have nowhere else to go).
  const isMovable = page.type === 'page' || (page.type === 'folder' && !!page.parent_id);
  if (isMovable) {
    items.push({ label: 'Move to…', icon: ICON.folderMove, onClick: () => openMoveModal('page', page.id) });
  }

  items.push({ label: 'Delete', icon: ICON.trash, danger: true, onClick: () => deletePageConfirm(page.id, displayName) });

  openCardMenu({ x: me.clientX, y: me.clientY }, items);
}




// ── Page title inline editing ─────────────────────────────────────────────────
let titleTimer: ReturnType<typeof setTimeout> | undefined;

function onTitleChange(e: Event): void {
  if (state.currentPage?.locked) return;
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

async function togglePageLock(): Promise<void> {
  if (!state.currentPage || state.currentPage.type !== 'page') return;
  try {
    const next = !state.currentPage.locked;
    const { page } = await api.setPageLocked(state.currentPage.id, next);
    state.currentPage.locked = page.locked ?? next;
    updateTopbar(state.currentPage);
    await renderPage(state.currentPage.id);
    showToast(next ? 'File locked' : 'File unlocked');
  } catch (err) {
    showToast('Lock failed: ' + (err as Error).message, 'error');
  }
}

function shareTargetKindLabel(target = currentShareTarget): string {
  if (!target) return 'page';
  if (target.kind === 'page') return 'page';
  return target.assetType;
}

function shareTargetTitle(target = currentShareTarget): string {
  const kind = shareTargetKindLabel(target);
  return kind.charAt(0).toUpperCase() + kind.slice(1);
}

function assetShareType(asset: Asset): 'image' | 'document' | 'file' {
  const mime = asset.mime_type || '';
  const ext = asset.original_name.split('.').pop()?.toLowerCase() || '';
  const documentExts = new Set(['pdf', 'txt', 'md', 'markdown', 'html', 'htm', 'csv', 'json', 'xml', 'yaml', 'yml', 'toml', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'rtf']);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('text/') || mime === 'application/pdf' || documentExts.has(ext)) return 'document';
  return 'file';
}

function updateShareModalCopy(): void {
  const kind = shareTargetKindLabel();
  const title = shareTargetTitle();
  const titleEl = document.getElementById('share-modal-title-text');
  const passwordLabel = document.getElementById('share-password-label');
  const note = document.getElementById('share-modal-note');
  const urlLabel = document.getElementById('share-link-label');

  if (titleEl) titleEl.textContent = `Share ${kind}`;
  if (urlLabel) urlLabel.textContent = 'Read-only link';
  if (passwordLabel) passwordLabel.textContent = `Password protect this shared ${kind}`;
  if (note) {
    note.textContent = `Shared ${kind}s are always read-only. Anyone with the link can view unless password protection is enabled.`;
  }

  const passwordInput = document.getElementById('share-page-password') as HTMLInputElement | null;
  if (passwordInput && !passwordInput.value) {
    passwordInput.placeholder = `Set a password for this shared ${kind}`;
  }
  const publishBtn = document.getElementById('share-save-btn') as HTMLButtonElement | null;
  if (publishBtn && !currentShareInfo?.enabled) publishBtn.textContent = `Publish ${title.toLowerCase()}`;
}

function renderShareModalState(share: PageShareInfo): void {
  currentShareInfo = share;
  updateShareModalCopy();
  const kind = shareTargetKindLabel();
  const status = $('share-modal-status');
  const linkGroup = $('share-link-group') as HTMLElement;
  const urlInput = $('share-page-url') as HTMLInputElement;
  const passwordToggle = $('share-password-enabled') as HTMLInputElement;
  const passwordInput = $('share-page-password') as HTMLInputElement;
  const saveBtn = $('share-save-btn') as HTMLButtonElement;
  const unpublishBtn = $('share-unpublish-btn') as HTMLButtonElement;

  status.classList.remove('loading', 'published', 'error');
  status.classList.add(share.enabled ? 'published' : 'draft');
  status.textContent = share.enabled
    ? share.password_protected ? 'Published with password protection' : 'Published as read-only'
    : 'Not published yet';

  linkGroup.style.display = share.enabled && share.url ? '' : 'none';
  urlInput.value = share.url ?? '';
  passwordToggle.checked = !!share.password_protected;
  passwordInput.value = '';
  passwordInput.placeholder = share.password_protected
    ? 'Leave blank to keep current password'
    : `Set a password for this shared ${kind}`;

  saveBtn.disabled = false;
  saveBtn.textContent = share.enabled ? 'Update share' : `Publish ${kind}`;
  unpublishBtn.disabled = false;
  unpublishBtn.style.display = share.enabled ? '' : 'none';
  syncSharePasswordUI();
}

function setShareModalLoading(message = 'Loading share settings...'): void {
  updateShareModalCopy();
  const status = $('share-modal-status');
  status.classList.remove('published', 'draft', 'error');
  status.classList.add('loading');
  status.textContent = message;
  ($('share-link-group') as HTMLElement).style.display = 'none';
  ($('share-page-url') as HTMLInputElement).value = '';
  ($('share-page-password') as HTMLInputElement).value = '';
  ($('share-save-btn') as HTMLButtonElement).disabled = true;
  ($('share-unpublish-btn') as HTMLButtonElement).disabled = true;
}

function setShareModalError(message: string): void {
  const status = $('share-modal-status');
  status.classList.remove('loading', 'published', 'draft');
  status.classList.add('error');
  status.textContent = message;
  ($('share-save-btn') as HTMLButtonElement).disabled = false;
  ($('share-unpublish-btn') as HTMLButtonElement).disabled = false;
}

async function openPageShareModal(): Promise<void> {
  if (!state.currentPageId || state.currentPage?.type !== 'page') return;
  closeCardMenu();
  currentShareTarget = { kind: 'page', id: state.currentPageId, label: state.currentPage.display_name || state.currentPage.name };
  $('share-page-overlay').classList.add('open');
  setShareModalLoading();

  try {
    const { share } = await api.getPageShare(currentShareTarget.id);
    renderShareModalState(share);
  } catch (err) {
    setShareModalError((err as Error).message);
    showToast('Failed to load share settings: ' + (err as Error).message, 'error');
  }
}

async function openAssetShareModal(assetId: string): Promise<void> {
  const asset = state.currentPage?.assets?.find(a => a.id === assetId);
  if (!asset) {
    showToast('Asset not found', 'error');
    return;
  }
  closeCardMenu();
  currentShareTarget = {
    kind: 'asset',
    id: asset.id,
    label: asset.original_name || asset.filename,
    assetType: assetShareType(asset),
  };
  $('share-page-overlay').classList.add('open');
  setShareModalLoading();

  try {
    const { share } = await api.getAssetShare(asset.id);
    renderShareModalState(share);
  } catch (err) {
    setShareModalError((err as Error).message);
    showToast('Failed to load share settings: ' + (err as Error).message, 'error');
  }
}

function closePageShareModal(): void {
  $('share-page-overlay').classList.remove('open');
  currentShareTarget = null;
  currentShareInfo = null;
}

function syncSharePasswordUI(): void {
  const enabled = ($('share-password-enabled') as HTMLInputElement).checked;
  const group = $('share-password-group') as HTMLElement;
  group.style.display = enabled ? '' : 'none';
}

async function publishCurrentPage(): Promise<void> {
  if (!currentShareTarget) return;
  const target = currentShareTarget;

  const passwordProtected = ($('share-password-enabled') as HTMLInputElement).checked;
  const passwordInput = $('share-page-password') as HTMLInputElement;
  const password = passwordInput.value.trim();
  if (passwordProtected && !password && !currentShareInfo?.password_protected) {
    showToast(`Enter a password before publishing this protected ${shareTargetKindLabel()}`, 'error');
    passwordInput.focus();
    return;
  }

  const saveBtn = $('share-save-btn') as HTMLButtonElement;
  const unpublishBtn = $('share-unpublish-btn') as HTMLButtonElement;
  saveBtn.disabled = true;
  unpublishBtn.disabled = true;
  const previousLabel = saveBtn.textContent || 'Publish';
  saveBtn.textContent = currentShareInfo?.enabled ? 'Updating...' : 'Publishing...';

  try {
    const payload: { password_protected: boolean; password?: string } = { password_protected: passwordProtected };
    if (password) payload.password = password;
    const { share } = target.kind === 'page'
      ? await api.updatePageShare(target.id, payload)
      : await api.updateAssetShare(target.id, payload);
    renderShareModalState(share);
    if (target.kind === 'page' && state.currentPage?.id === target.id) {
      state.currentPage.share = share;
      updateTopbar(state.currentPage);
    }
    if (target.kind === 'asset' && state.currentPageId) {
      await renderPage(state.currentPageId);
    }
    showToast(share.enabled ? 'Share link updated' : 'Share saved');
  } catch (err) {
    saveBtn.disabled = false;
    unpublishBtn.disabled = false;
    saveBtn.textContent = previousLabel;
    showToast('Share failed: ' + (err as Error).message, 'error');
  }
}

async function unpublishCurrentPage(): Promise<void> {
  if (!currentShareTarget) return;
  if (!currentShareInfo?.enabled) return;
  const target = currentShareTarget;

  const saveBtn = $('share-save-btn') as HTMLButtonElement;
  const unpublishBtn = $('share-unpublish-btn') as HTMLButtonElement;
  saveBtn.disabled = true;
  unpublishBtn.disabled = true;

  try {
    const { share } = target.kind === 'page'
      ? await api.deletePageShare(target.id)
      : await api.deleteAssetShare(target.id);
    renderShareModalState(share);
    if (target.kind === 'page' && state.currentPage?.id === target.id) {
      state.currentPage.share = share;
      updateTopbar(state.currentPage);
    }
    if (target.kind === 'asset' && state.currentPageId) {
      await renderPage(state.currentPageId);
    }
    showToast(`Shared ${shareTargetKindLabel()} unpublished`);
  } catch (err) {
    saveBtn.disabled = false;
    unpublishBtn.disabled = false;
    showToast('Unpublish failed: ' + (err as Error).message, 'error');
  }
}

async function copyCurrentShareLink(): Promise<void> {
  const value = (($('share-page-url') as HTMLInputElement).value || currentShareInfo?.url || '').trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showToast('Share link copied');
  } catch {
    showToast('Copy failed', 'error');
  }
}


// ── Chat drawer ───────────────────────────────────────────────────────────────
function toggleChat(): void {
  if (!state.aiEnabled) return; // no AI configured — ignore
  state.chatOpen = !state.chatOpen;
  $('chat-drawer').classList.toggle('open', state.chatOpen);
  if (state.chatOpen) {
    void populateChatProfilePicker();
    if (state.currentPageId) loadChatHistory();
  }
}

// Populate the profile <select> in the chat drawer with the available LLM
// profiles, marking the currently active one as selected. Hides the row
// entirely when only zero or one profile exists (nothing to switch between).
async function populateChatProfilePicker(): Promise<void> {
  try {
    const { profiles, activeId } = await api.getProfiles();
    const row = $('chat-profile-row');
    const select = $('chat-profile-select') as HTMLSelectElement;
    if (!row || !select) return;
    if (profiles.length < 2) {
      row.style.display = 'none';
      return;
    }
    row.style.display = '';
    select.innerHTML = profiles.map(p => {
      const label = `${p.name} — ${p.provider}${p.model ? ' · ' + p.model : ''}`;
      const sel = p.id === activeId ? ' selected' : '';
      return `<option value="${esc(p.id)}"${sel}>${esc(label)}</option>`;
    }).join('');
  } catch { /* silently ignore — picker just stays hidden */ }
}

async function changeChatProfile(id: string): Promise<void> {
  if (!id) return;
  try {
    await api.setActiveProfile(id);
    // Pre-cached lists used elsewhere in the UI need to know about the change.
    activeProfileId = id;
    showToast('Switched AI profile');
  } catch (err) {
    showToast('Switch failed: ' + (err as Error).message, 'error');
    // Revert the select to whatever the server still considers active.
    void populateChatProfilePicker();
  }
}

function toggleSidebar(): void {
  const sidebar = $('sidebar');
  const collapsed = sidebar.classList.toggle('collapsed');
  localStorage.setItem('yk-sidebar-collapsed', collapsed ? '1' : '0');
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
    container.innerHTML = `<div style="text-align:center;padding:40px 16px;color:var(--text-dim);font-size:14px;"><img src="/mascot.svg" alt="Yoinko" class="chat-empty-mascot"><div>Ask me anything about this page,<br>or request changes!</div></div>`;
    return;
  }
  container.innerHTML = state.chatMessages.map(m => `
    <div class="chat-msg ${m.role}">
      ${m.role === 'assistant' ? '<img src="/mascot.svg" alt="AI" class="chat-msg-avatar">' : ''}
      <div class="chat-msg-bubble">
        <div class="chat-msg-role">${m.role === 'user' ? 'You' : 'Yoyo'}</div>
        <div class="chat-msg-content">${m.role === 'assistant' ? renderMarkdownSimple(m.content) : esc(m.content)}</div>
      </div>
    </div>
  `).join('');
  container.scrollTop = container.scrollHeight;
}

function renderMarkdownSimple(text: string): string {
  // 1. Extract code blocks before escaping so we can handle them separately
  const codeBlocks: string[] = [];
  const placeholder = '\x00CB\x00';
  const withPlaceholders = text.replace(/```([\s\S]*?)```/g, (_match, code: string) => {
    // Strip optional language tag from first line
    const cleaned = code.replace(/^[^\n]*\n/, '');
    codeBlocks.push(cleaned);
    return placeholder;
  });

  // 2. Escape the entire remaining text (prevents HTML injection)
  let safe = esc(withPlaceholders);

  // 3. Apply inline markdown transforms on the escaped text
  safe = safe
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/\n/g, '<br>');

  // 4. Re-inject escaped code blocks
  let i = 0;
  safe = safe.replace(new RegExp(placeholder.replace(/\x00/g, '\\x00'), 'g'), () => {
    const code = esc(codeBlocks[i++] ?? '');
    return `<pre style="background:var(--surface-3);padding:8px;border-radius:6px;font-size:12px;overflow-x:auto;margin:6px 0"><code>${code}</code></pre>`;
  });

  return safe;
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
      <img src="/mascot.svg" alt="AI" class="chat-msg-avatar">
      <div class="chat-msg-bubble">
        <div class="chat-msg-role">Yoyo</div>
        <div class="chat-typing"><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div><div class="chat-typing-dot"></div></div>
      </div>
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
  if (state.currentPageId) {
    api.deleteChatHistory(state.currentPageId).catch(() => { });
  }
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

// ── Settings modal — Multi-Profile LLM Config ────────────────────────────────

type ProfileWithMask = LLMProfile & { api_key_masked?: string };

let profilesList: ProfileWithMask[] = [];
let activeProfileId = '';
let selectedProfileId = '';

const PROVIDER_ICONS: Record<string, string> = {
  openai: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.998 5.998 0 0 0-3.998 2.9 6.042 6.042 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>',
  gemini: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M12 0C5.352 0 0 5.352 0 12s5.352 12 12 12 12-5.352 12-12S18.648 0 12 0zm0 2.4a9.6 9.6 0 0 1 9.6 9.6c0 .12-.012.24-.012.348-1.836-3.468-5.46-5.748-9.588-5.748S4.248 8.88 2.412 12.348A9.355 9.355 0 0 1 2.4 12 9.6 9.6 0 0 1 12 2.4zm0 19.2A9.6 9.6 0 0 1 2.4 12c0-.12.012-.24.012-.348C4.248 15.12 7.872 17.4 12 17.4s7.752-2.28 9.588-5.748c0 .108.012.228.012.348a9.6 9.6 0 0 1-9.6 9.6z"/></svg>',
  claude: '<svg width="16" height="16" viewBox="0 0 24 24"><path fill="currentColor" d="M17.304 4.044l-3.672 12.348h-2.88L7.08 4.044h2.736l2.232 8.688 2.328-8.688zM5.4 17.604h13.2v2.352H5.4z"/></svg>',
  'openai-compatible': '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="8" height="8" rx="1"/><rect x="14" y="2" width="8" height="8" rx="1"/><rect x="2" y="14" width="8" height="8" rx="1"/><path d="M14 14h4v4h4M14 18h4"/></svg>',
};

const PROVIDER_DEFAULTS: Record<string, string> = {
  openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash',
  claude: 'claude-3-5-haiku-20241022',
  'openai-compatible': '',
};

async function openSettings(): Promise<void> {
  $('settings-overlay').classList.add('open');
  try {
    const { profiles, activeId } = await api.getProfiles();
    profilesList = profiles;
    activeProfileId = activeId;

    // Legacy migration: if no profiles exist but legacy settings do, create one
    if (profiles.length === 0) {
      const { settings } = await api.getSettings();
      if (settings.llm_provider || settings.llm_api_key) {
        const migrated: LLMProfile = {
          id: crypto.randomUUID(),
          name: 'Default',
          provider: settings.llm_provider || 'openai',
          model: settings.llm_model || '',
          api_key: settings.llm_api_key || '',
          base_url: settings.llm_base_url || '',
          image_model: settings.image_model || 'dall-e-3',
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
    showToast('Failed to load settings', 'error');
  }
}

function closeSettings(): void {
  $('settings-overlay').classList.remove('open');
  // If the template editor was open, tear it down so we don't leak a
  // ProseMirror view across modal opens.
  setTemplateEditorOpen(false);
  // Re-evaluate AI availability in case the user just added/removed a profile
  void applyAIVisibility();
}

// ── Settings tabs (AI Profiles | Templates) ──────────────────────────────────
function openSettingsTab(tab: 'ai' | 'templates'): void {
  $('settings-tab-ai').style.display = tab === 'ai' ? '' : 'none';
  $('settings-tab-templates').style.display = tab === 'templates' ? '' : 'none';
  $('stab-ai').classList.toggle('active', tab === 'ai');
  $('stab-templates').classList.toggle('active', tab === 'templates');
  if (tab === 'templates') void loadTemplates();
}

// ── MD Templates ────────────────────────────────────────────────────────────
let templatesList: MdTemplate[] = [];
let editingTemplateId: string | null = null;

async function loadTemplates(): Promise<void> {
  try {
    const { templates } = await api.getTemplates();
    templatesList = templates || [];
    renderTemplatesList();
    populateNewPageTemplateSelect();
  } catch {
    showToast('Failed to load templates', 'error');
  }
}

function renderTemplatesList(): void {
  const list = $('templates-list');
  if (!templatesList.length) {
    list.innerHTML = `
      <div class="settings-empty" style="padding:24px 0;">
        <p>No templates yet. Click <strong>+ New Template</strong> to create one.</p>
      </div>
    `;
    return;
  }
  list.innerHTML = templatesList.map(t => {
    const firstLine = (t.content || '').split('\n').find(l => l.trim()) || '';
    return `
      <div class="template-item" onclick="editTemplate('${t.id}')">
        <span class="template-item-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px"><path d="M 6 3 H 14 L 19 8 V 21 H 6 Z"/><path d="M 14 3 V 8 H 19"/><path d="M 9 12 H 16"/><path d="M 9 15 H 16"/><path d="M 9 18 H 13"/></svg></span>
        <div class="template-item-info">
          <div class="template-item-name">${esc(t.name)}</div>
          <div class="template-item-preview">${esc(firstLine.slice(0, 80))}</div>
        </div>
        <div class="template-item-actions" onclick="event.stopPropagation()">
          <button class="btn btn-ghost btn-sm" onclick="editTemplate('${t.id}')">Edit</button>
          <button class="btn btn-ghost btn-sm" style="color:var(--danger)" onclick="deleteTemplateById('${t.id}')">Delete</button>
        </div>
      </div>
    `;
  }).join('');
}

// TipTap editor mounted inside the template form (replaces the old textarea
// so users get the same WYSIWYG experience as the page editor: markdown
// shortcuts, lists, tasks, headings, links, etc).
interface MiniEditor { destroy: () => void; getJSON: () => TipTapDoc }
let templateContentEditor: MiniEditor | null = null;

function mountTemplateContentEditor(initialMarkdown: string): void {
  destroyTemplateContentEditor();
  if (!window.TipTapBundle) return;
  const { Editor, StarterKit, TaskList, TaskItem, Underline, Link, ListKeymap, Placeholder } = window.TipTapBundle;
  const initialHtml = initialMarkdown ? renderMarkdown(initialMarkdown) : '';
  type EditorCtor = new (opts: Record<string, unknown>) => MiniEditor;
  templateContentEditor = new (Editor as unknown as EditorCtor)({
    element: $('template-content-editor'),
    extensions: [
      (StarterKit as { configure: (opts: Record<string, unknown>) => unknown }).configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
      }),
      TaskList,
      (TaskItem as { configure: (opts: Record<string, unknown>) => unknown }).configure({ nested: true }),
      Underline,
      (Link as { configure: (opts: Record<string, unknown>) => unknown }).configure({
        openOnClick: false,
        validate: () => true,
        HTMLAttributes: { rel: 'noopener noreferrer' },
      }),
      ListKeymap,
      (Placeholder as { configure: (opts: Record<string, unknown>) => unknown }).configure({
        placeholder: 'Write your template here… # heading, - list, [] task, ** bold',
      }),
    ],
    content: initialHtml,
    editorProps: {
      attributes: { class: 'tiptap-content', spellcheck: 'true' },
    },
  });
}

function destroyTemplateContentEditor(): void {
  if (templateContentEditor) {
    try { templateContentEditor.destroy(); } catch { /* already destroyed */ }
    templateContentEditor = null;
  }
}

function getTemplateContentMarkdown(): string {
  if (!templateContentEditor) return '';
  return tiptapToMarkdown(templateContentEditor.getJSON()).replace(/\n+$/, '');
}

function setTemplateEditorOpen(open: boolean): void {
  $('template-editor').style.display = open ? '' : 'none';
  // Hide the list (and its empty state) while editing — they share visual space
  // and the empty-state copy is misleading when the editor is in fact open.
  $('templates-list').style.display = open ? 'none' : '';
  // Hide the "+ New Template" button while editing so the user finishes/cancels
  // first instead of stacking another empty editor.
  const headerBtn = document.querySelector<HTMLButtonElement>(
    '.templates-list-header button',
  );
  if (headerBtn) headerBtn.style.display = open ? 'none' : '';
  if (!open) destroyTemplateContentEditor();
}

function openNewTemplateForm(): void {
  editingTemplateId = null;
  ($('template-name') as HTMLInputElement).value = '';
  setTemplateEditorOpen(true);
  mountTemplateContentEditor('');
  setTimeout(() => ($('template-name') as HTMLInputElement).focus(), 50);
}

function editTemplate(id: string): void {
  const t = templatesList.find(x => x.id === id);
  if (!t) return;
  editingTemplateId = id;
  ($('template-name') as HTMLInputElement).value = t.name;
  setTemplateEditorOpen(true);
  mountTemplateContentEditor(t.content || '');
  setTimeout(() => ($('template-name') as HTMLInputElement).focus(), 50);
}

function cancelTemplateEdit(): void {
  setTemplateEditorOpen(false);
  editingTemplateId = null;
}

async function saveCurrentTemplate(): Promise<void> {
  const name = ($('template-name') as HTMLInputElement).value.trim();
  const content = getTemplateContentMarkdown();
  if (!name) { showToast('Template name is required', 'error'); return; }
  const id = editingTemplateId || (crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}`);
  try {
    await api.saveTemplate({ id, name, content });
    showToast('Template saved');
    cancelTemplateEdit();
    await loadTemplates();
  } catch (err) {
    showToast('Save failed: ' + (err as Error).message, 'error');
  }
}

async function deleteTemplateById(id: string): Promise<void> {
  const t = templatesList.find(x => x.id === id);
  if (!t) return;
  const confirmed = await showConfirmDelete(t.name, 'Delete template?');
  if (!confirmed) return;
  try {
    await api.deleteTemplate(id);
    showToast('Template deleted');
    if (editingTemplateId === id) cancelTemplateEdit();
    await loadTemplates();
  } catch (err) {
    showToast('Delete failed: ' + (err as Error).message, 'error');
  }
}

function populateNewPageTemplateSelect(): void {
  const select = $('new-page-template') as HTMLSelectElement | null;
  if (!select) return;
  const previous = select.value;
  select.innerHTML = '<option value="">— Blank page —</option>';
  for (const t of templatesList) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    select.appendChild(opt);
  }
  // Preserve selection if still valid
  if (previous && templatesList.some(t => t.id === previous)) select.value = previous;
}

function renderProfilesList(): void {
  const list = $('profiles-list');
  list.innerHTML = profilesList.map(p => `
    <div class="profile-item ${p.id === selectedProfileId ? 'selected' : ''}" onclick="selectProfileItem('${p.id}')">
      <span class="profile-item-icon">${PROVIDER_ICONS[p.provider] || '🤖'}</span>
      <span class="profile-item-name">${escapeHtml(p.name)}</span>
      ${p.id === activeProfileId ? '<span class="profile-active-badge">active</span>' : ''}
    </div>
  `).join('');
}

function selectProfileItem(id: string): void {
  selectedProfileId = id;
  renderProfilesList();
  const profile = profilesList.find(p => p.id === id);
  if (!profile) return;

  // Show form, hide empty
  $('profile-form').style.display = '';
  $('profile-empty').style.display = 'none';

  // Populate form
  ($('profile-name') as HTMLInputElement).value = profile.name;
  ($('settings-provider') as HTMLSelectElement).value = profile.provider || 'openai';
  ($('settings-model') as HTMLInputElement).value = profile.model || '';
  ($('settings-api-key') as HTMLInputElement).value = '';
  ($('settings-api-key') as HTMLInputElement).placeholder = profile.api_key_masked || 'Enter API key…';
  ($('settings-base-url') as HTMLInputElement).value = profile.base_url || '';

  ($('settings-image-model') as HTMLInputElement).value = profile.image_model || '';

  updateProviderCards(profile.provider || 'openai');
  updateProviderUI(profile.provider || 'openai');

  // Update active button state
  const activeBtn = $('set-active-btn') as HTMLButtonElement;
  const starSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:13px;height:13px;display:inline-block;vertical-align:-2px;margin-right:3px"><path d="M 12 3 L 14.5 9 L 21 10 L 16 14.5 L 17.5 21 L 12 17.5 L 6.5 21 L 8 14.5 L 3 10 L 9.5 9 Z"/></svg>';
  if (id === activeProfileId) {
    activeBtn.innerHTML = `${starSvg}Active`;
    activeBtn.disabled = true;
    activeBtn.className = 'btn btn-danger btn-sm';
  } else {
    activeBtn.innerHTML = `${starSvg}Set Active`;
    activeBtn.disabled = false;
    activeBtn.className = 'btn btn-primary btn-sm';
  }
}

function showEmptyState(): void {
  $('profile-form').style.display = 'none';
  $('profile-empty').style.display = '';
}

function addNewProfile(): void {
  const id = crypto.randomUUID();
  const newProfile: ProfileWithMask = {
    id,
    name: `Profile ${profilesList.length + 1}`,
    provider: 'openai',
    model: 'gpt-4o-mini',
    api_key: '',
    base_url: '',
    image_model: 'dall-e-3',
    api_key_masked: '',
  };
  profilesList.push(newProfile);
  renderProfilesList();
  selectProfileItem(id);
  ($('profile-name') as HTMLInputElement).focus();
}

async function saveCurrentProfile(): Promise<void> {
  const profile = profilesList.find(p => p.id === selectedProfileId);
  if (!profile) return;

  const updated: LLMProfile = {
    id: profile.id,
    name: ($('profile-name') as HTMLInputElement).value.trim() || profile.name,
    provider: ($('settings-provider') as HTMLSelectElement).value as LLMProfile['provider'],
    model: ($('settings-model') as HTMLInputElement).value,
    api_key: ($('settings-api-key') as HTMLInputElement).value || '',
    base_url: ($('settings-base-url') as HTMLInputElement).value,
    image_model: ($('settings-image-model') as HTMLInputElement).value.trim(),
  };

  try {
    await api.saveProfile(updated);
    // Refresh the list
    const { profiles, activeId } = await api.getProfiles();
    profilesList = profiles;
    activeProfileId = activeId;
    renderProfilesList();
    selectProfileItem(profile.id);
    showToast('Profile saved!');
  } catch (err) {
    showToast('Save failed: ' + (err as Error).message, 'error');
  }
}

async function deleteCurrentProfile(): Promise<void> {
  if (!selectedProfileId) return;
  const profile = profilesList.find(p => p.id === selectedProfileId);
  if (!profile) return;

  // Show a custom confirmation modal.
  const nameEl = document.getElementById('delete-profile-name');
  if (nameEl) nameEl.textContent = `"${profile.name}"`;
  document.getElementById('delete-profile-overlay')?.classList.add('open');
}

async function confirmDeleteProfile(): Promise<void> {
  document.getElementById('delete-profile-overlay')?.classList.remove('open');
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
      selectedProfileId = '';
      showEmptyState();
    }
    showToast('Profile deleted');
  } catch (err) {
    showToast('Delete failed: ' + (err as Error).message, 'error');
  }
}

async function setActiveCurrentProfile(): Promise<void> {
  if (!selectedProfileId || selectedProfileId === activeProfileId) return;
  try {
    await api.setActiveProfile(selectedProfileId);
    activeProfileId = selectedProfileId;
    renderProfilesList();
    selectProfileItem(selectedProfileId);
    const name = profilesList.find(p => p.id === selectedProfileId)?.name || '';
    showToast(`"${name}" is now active`);
  } catch (err) {
    showToast('Failed: ' + (err as Error).message, 'error');
  }
}

function selectProvider(p: string): void {
  ($('settings-provider') as HTMLSelectElement).value = p;
  updateProviderCards(p);
  updateProviderUI(p);
  const modelEl = $('settings-model') as HTMLInputElement;
  if (!modelEl.value) modelEl.value = PROVIDER_DEFAULTS[p] || '';
}

function updateProviderCards(p: string): void {
  $$('.provider-card').forEach(c => c.classList.toggle('selected', c.dataset.provider === p));
}

function updateProviderUI(p: string): void {
  $('base-url-row').style.display = p === 'openai-compatible' ? '' : 'none';
}

// ── Lightbox ──────────────────────────────────────────────────────────────────



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

// ── Cloud storage bar ─────────────────────────────────────────────────────────
async function loadStorageUsage(): Promise<void> {
  try {
    const { usage } = await api.getStorageUsage();
    if (!usage.isCloud) return;
    const bar = document.getElementById('sidebar-storage');
    if (!bar) return;
    bar.style.display = '';
    const pct = Math.min(100, (usage.used / usage.limit) * 100);
    const warnClass = pct >= 95 ? 'danger' : pct >= 80 ? 'warn' : '';
    bar.innerHTML = `
      <div class="storage-bar-label">
        <span>Storage</span>
        <span>${formatBytes(usage.used)} / ${formatBytes(usage.limit)}</span>
      </div>
      <div class="storage-bar-track">
        <div class="storage-bar-fill ${warnClass}" style="width:${pct.toFixed(1)}%"></div>
      </div>`;
  } catch { /* non-cloud or offline — leave bar hidden */ }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
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

// ── Sidebar search ────────────────────────────────────────────────────────────
let searchTimer: ReturnType<typeof setTimeout> | undefined;

function onSearch(): void {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderSidebar(), 200);
}

// ── Find in page ──────────────────────────────────────────────────────────────

let _findMatches: HTMLElement[] = [];
let _findIndex = -1;
const FIND_MARK_CLASS = 'find-highlight';
const FIND_MARK_ACTIVE_CLASS = 'find-highlight-active';

// Skips elements that are not readable content (code editor chrome, UI widgets)
const FIND_SKIP_SELECTORS = [
  '.tab-bar', '.topbar', '.find-bar', '.sidebar', '.chat-drawer',
  '.editor-toolbar', '.asset-menu-btn', '.child-card-menu-btn',
  'button', 'input', 'select', 'textarea',
];

function openFindBar(): void {
  const bar = $('find-bar');
  bar.style.display = '';
  const input = $('find-input') as HTMLInputElement;
  input.value = '';
  input.focus();
  input.select();
  $('find-count').textContent = '';
  clearFindHighlights();
}

function closeFindBar(): void {
  $('find-bar').style.display = 'none';
  clearFindHighlights();
  _findMatches = [];
  _findIndex = -1;
}

function clearFindHighlights(): void {
  const marks = document.querySelectorAll<HTMLElement>(`.${FIND_MARK_CLASS}`);
  marks.forEach(m => {
    const parent = m.parentNode;
    if (!parent) return;
    parent.replaceChild(document.createTextNode(m.textContent ?? ''), m);
    parent.normalize();
  });
  _findMatches = [];
  _findIndex = -1;
}

function runFind(query: string): void {
  clearFindHighlights();
  if (!query) { $('find-count').textContent = ''; return; }

  const root = $('content-area');
  const lq = query.toLowerCase();

  // Walk all text nodes inside content-area, skip UI elements
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const el = node.parentElement;
      if (!el) return NodeFilter.FILTER_REJECT;
      for (const sel of FIND_SKIP_SELECTORS) {
        if (el.closest(sel)) return NodeFilter.FILTER_REJECT;
      }
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const matches: HTMLElement[] = [];
  let textNode: Text | null;
  while ((textNode = walker.nextNode() as Text | null)) {
    const text = textNode.textContent ?? '';
    const ltext = text.toLowerCase();
    let pos = 0;
    let idx: number;
    const frags: (string | HTMLElement)[] = [];
    while ((idx = ltext.indexOf(lq, pos)) !== -1) {
      if (idx > pos) frags.push(text.slice(pos, idx));
      const mark = document.createElement('mark');
      mark.className = FIND_MARK_CLASS;
      mark.textContent = text.slice(idx, idx + query.length);
      frags.push(mark);
      matches.push(mark);
      pos = idx + query.length;
    }
    if (!frags.length) continue;
    if (pos < text.length) frags.push(text.slice(pos));
    const parent = textNode.parentNode!;
    const anchor = document.createDocumentFragment();
    frags.forEach(f => anchor.appendChild(typeof f === 'string' ? document.createTextNode(f) : f));
    parent.replaceChild(anchor, textNode);
  }

  _findMatches = matches;
  _findIndex = matches.length ? 0 : -1;
  activateFindMatch(_findIndex);
  updateFindCount();
}

function activateFindMatch(idx: number): void {
  _findMatches.forEach((m, i) => m.classList.toggle(FIND_MARK_ACTIVE_CLASS, i === idx));
  if (idx >= 0 && _findMatches[idx]) {
    _findMatches[idx].scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}

function updateFindCount(): void {
  const count = $('find-count');
  if (!_findMatches.length) {
    count.textContent = 'No results';
    count.style.color = 'var(--tomato)';
  } else {
    count.textContent = `${_findIndex + 1} / ${_findMatches.length}`;
    count.style.color = '';
  }
}

function findNext(): void {
  if (!_findMatches.length) return;
  _findIndex = (_findIndex + 1) % _findMatches.length;
  activateFindMatch(_findIndex);
  updateFindCount();
}

function findPrev(): void {
  if (!_findMatches.length) return;
  _findIndex = (_findIndex - 1 + _findMatches.length) % _findMatches.length;
  activateFindMatch(_findIndex);
  updateFindCount();
}

// ── Markdown render helper ────────────────────────────────────────────────────
function renderMarkdown(text: string): string {
  if (typeof marked === 'undefined') return `<pre>${esc(text || '')}</pre>`;
  const result = marked.parse(text || '', { async: false, gfm: true, breaks: false });
  const html = typeof result === 'string' ? result : `<pre>${esc(text || '')}</pre>`;

  // Convert marked's GFM checkbox output into TipTap taskList/taskItem markup
  // by walking the parsed DOM. This handles nested lists correctly — the
  // previous regex-based version captured from an outer <ul> to the FIRST
  // closing </ul>, which is the inner one when a task item has nested
  // bullets, producing malformed HTML and breaking round-trip saves.
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;

  for (const ul of Array.from(wrapper.querySelectorAll('ul'))) {
    const directLis = Array.from(ul.children).filter(
      (c): c is HTMLLIElement => c.tagName === 'LI',
    );
    if (!directLis.length) continue;

    const isTaskList = directLis.some(li =>
      li.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]'),
    );
    if (!isTaskList) continue;

    ul.setAttribute('data-type', 'taskList');

    for (const li of directLis) {
      const cb = li.querySelector(
        ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]',
      ) as HTMLInputElement | null;
      if (!cb) continue;

      const isChecked = cb.hasAttribute('checked') || cb.checked;

      // Capture the leading inline content (everything up to the first nested
      // <ul>/<ol>) and leave nested lists in place as siblings of <label>.
      let leadingHtml = '';
      const leadingP = li.querySelector(':scope > p');
      if (leadingP && leadingP.contains(cb)) {
        // Loose form: <li><p><input> text</p>...nested...</li>
        cb.remove();
        leadingHtml = leadingP.innerHTML.trim();
        leadingP.remove();
      } else {
        // Tight form: <li><input> text...nested...</li>
        cb.remove();
        const buf = document.createElement('div');
        for (const child of Array.from(li.childNodes)) {
          if (child.nodeType === Node.ELEMENT_NODE) {
            const tag = (child as Element).tagName;
            if (tag === 'UL' || tag === 'OL') break;
          }
          buf.appendChild(child); // moves the node out of li
        }
        leadingHtml = buf.innerHTML.trim();
      }

      li.setAttribute('data-type', 'taskItem');
      li.setAttribute('data-checked', isChecked ? 'true' : 'false');

      const label = document.createElement('label');
      label.innerHTML = `<input type="checkbox"${isChecked ? ' checked' : ''}><span>${leadingHtml}</span>`;
      li.insertBefore(label, li.firstChild);
    }
  }

  return wrapper.innerHTML;
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

  // When the file-type changes, the template dropdown's relevance changes
  // (templates are markdown). Re-evaluate visibility via the existing helper.
  $('new-page-file-type').addEventListener('change', () => {
    const t = ($('new-page-type') as HTMLSelectElement).value;
    updateTypeOptions(t);
  });
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


  document.addEventListener('click', (e: MouseEvent) => {
    if (state.chatOpen && !(e.target as Element).closest('.chat-drawer') && !(e.target as Element).closest('#chat-toggle')) {
      state.chatOpen = false;
      $('chat-drawer').classList.remove('open');
    }
    const target = e.target as Element;
    if (!target.closest('#floating-card-menu') && !target.closest('.asset-menu-btn') && !target.closest('.child-card-menu-btn')) {
      closeCardMenu();
    }
  });
  window.addEventListener('scroll', closeCardMenu, true);
  window.addEventListener('resize', closeCardMenu);
  document.addEventListener('keydown', handleSheetDeleteKeydown, true);
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape' && _activeMenuTrigger) closeCardMenu();
    if (e.key === 'Escape' && $('find-bar').style.display !== 'none') closeFindBar();
    if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !e.shiftKey) {
      // Only intercept Ctrl/Cmd+F when focus is in the main area (not a modal / input)
      const active = document.activeElement;
      const inModal = active?.closest('.modal, .overlay, .chat-drawer, .sidebar');
      if (!inModal) { e.preventDefault(); openFindBar(); }
    }
  });

  // Find bar interactions
  let _findTimer: ReturnType<typeof setTimeout> | undefined;
  ($('find-input') as HTMLInputElement).addEventListener('input', function () {
    clearTimeout(_findTimer);
    _findTimer = setTimeout(() => runFind(this.value), 150);
  });
  ($('find-input') as HTMLInputElement).addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.shiftKey ? findPrev() : findNext(); }
    if (e.key === 'Escape') closeFindBar();
  });
  $('find-prev').addEventListener('click', findPrev);
  $('find-next').addEventListener('click', findNext);
  $('find-close').addEventListener('click', closeFindBar);

  $('confirm-delete-cancel').addEventListener('click', () => closeConfirmDelete(false));
  $('confirm-delete-ok').addEventListener('click', () => closeConfirmDelete(true));
  $('confirm-delete-overlay').addEventListener('click', (e: MouseEvent) => { if (e.target === $('confirm-delete-overlay')) closeConfirmDelete(false); });

  $('new-page-overlay').addEventListener('click', (e: MouseEvent) => { if (e.target === $('new-page-overlay')) closeNewPageModal(); });
  $('settings-overlay').addEventListener('click', (e: MouseEvent) => { if (e.target === $('settings-overlay')) closeSettings(); });
  $('lightbox').addEventListener('click', (e: MouseEvent) => { if (e.target === $('lightbox')) closeLightbox(); });
  $('move-item-overlay').addEventListener('click', (e: MouseEvent) => { if (e.target === $('move-item-overlay')) closeMoveModal(); });
  $('share-page-overlay').addEventListener('click', (e: MouseEvent) => { if (e.target === $('share-page-overlay')) closePageShareModal(); });

  // Custom Move-target dropdown — toggle on trigger click, close on outside click
  $('move-target-trigger').addEventListener('click', (e: MouseEvent) => {
    e.stopPropagation();
    const wrapper = $('move-target-select');
    const wasOpen = wrapper.classList.contains('open');
    wrapper.classList.toggle('open');
    if (!wasOpen) positionMoveTargetPanel();
  });
  document.addEventListener('click', (e: MouseEvent) => {
    const wrapper = $('move-target-select');
    const panel = $('move-target-panel');
    if (!wrapper) return;
    const target = e.target as Node;
    // Panel is position:fixed (rendered outside the wrapper in stacking, but
    // still a DOM child) so wrapper.contains() still covers it.
    if (!wrapper.contains(target) && !panel.contains(target)) {
      wrapper.classList.remove('open');
    }
  });
  // Reposition the panel when the modal scrolls or the viewport resizes.
  window.addEventListener('resize', () => positionMoveTargetPanel());
  window.addEventListener('scroll', () => positionMoveTargetPanel(), true);
  $('create-project-overlay').addEventListener('click', (e: MouseEvent) => { if (e.target === $('create-project-overlay')) closeCreateProjectModal(); });
  $('rename-project-overlay').addEventListener('click', (e: MouseEvent) => { if (e.target === $('rename-project-overlay')) closeRenameProjectModal(); });

  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeLightbox();
      closeConfirmDelete(false);
      closeCreateProjectModal();
      closeRenameProjectModal();
      closePageShareModal();

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
