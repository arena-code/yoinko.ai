// src/client/api.ts — Typed API client (multi-project aware)
import type {
  PageNode, Asset, Settings, LLMMessage, ChatMessage, Project, LLMProfile,
  PagesResponse, PageResponse, AssetsResponse, AssetResponse,
  SettingsResponse, SuccessResponse, ProjectsResponse,
} from '../shared/types.js';

const API_BASE = '/api';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

// Current project — set via api.setProject(), persisted in localStorage
let _currentProjectId: string = localStorage.getItem('yoinko_project') ?? 'default';

export function getCurrentProjectId(): string { return _currentProjectId; }

export function setCurrentProjectId(id: string): void {
  _currentProjectId = id;
  localStorage.setItem('yoinko_project', id);
}

// ── Auth expiry handler ─────────────────────────────────────────────────────
// Called whenever the server returns 401 (token expired) or 403 (invalid token).
// Clears all client-side storage and redirects to the logout endpoint so the
// user is cleanly signed out and cannot perform any further writes.
let _logoutTriggered = false;
function handleAuthFailure(): never {
  if (!_logoutTriggered) {
    _logoutTriggered = true;
    try { localStorage.clear(); } catch { /* ignore */ }
    try { sessionStorage.clear(); } catch { /* ignore */ }
    window.location.replace('/auth/logout');
  }
  throw new Error('Session expired — signing out…');
}

async function request<T>(method: HttpMethod, path: string, body?: unknown, isFormData = false): Promise<T> {
  const headers: Record<string, string> = isFormData
    ? { 'X-Project-Id': _currentProjectId }
    : { 'Content-Type': 'application/json', 'X-Project-Id': _currentProjectId };

  const opts: RequestInit = { method, headers };
  if (body !== undefined) {
    opts.body = isFormData ? (body as FormData) : JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);

  // Token expired or invalid — force logout immediately
  if (res.status === 401 || res.status === 403) {
    handleAuthFailure();
  }

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText })) as { error?: string };
    throw new Error(err.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface ChatStreamCallbacks {
  onChunk: (text: string) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

export interface AIGenerateParams {
  prompt: string;
  context?: string;
  type?: 'md' | 'html';
}

export interface AIImageParams {
  prompt: string;
  page_id?: string;
}

export interface CreatePageParams {
  name: string;
  type: 'page' | 'folder';
  file_type?: string;
  parent_id?: string | null;
  content?: string;
}

export interface UpdatePageParams {
  content?: string;
  name?: string;
}

export const api = {
  // ── Projects ───────────────────────────────────────────────────────────────
  listProjects: () => request<ProjectsResponse>('GET', '/projects'),
  createProject: (name: string) => request<{ project: Project }>('POST', '/projects', { name }),
  renameProject: (id: string, name: string) => request<{ project: Project }>('PATCH', `/projects/${id}`, { name }),
  deleteProject: (id: string) => request<SuccessResponse>('DELETE', `/projects/${id}`),

  // ── Pages ──────────────────────────────────────────────────────────────────
  getTree: () => request<PagesResponse>('GET', '/pages'),
  getFlat: () => request<PagesResponse>('GET', '/pages/flat'),
  getPage: (id: string) => request<PageResponse>('GET', `/pages/${id}`),
  createPage: (data: CreatePageParams) => request<PageResponse>('POST', '/pages', data),
  updatePage: (id: string, data: UpdatePageParams) => request<PageResponse>('PUT', `/pages/${id}`, data),
  deletePage: (id: string) => request<SuccessResponse>('DELETE', `/pages/${id}`),

  // ── Assets ─────────────────────────────────────────────────────────────────
  uploadFiles: (formData: FormData) => request<AssetsResponse>('POST', '/assets/upload', formData, true),
  getAssets: (pageId?: string) => request<AssetsResponse>('GET', `/assets${pageId ? `?page_id=${pageId}` : ''}`),
  deleteAsset: (id: string) => request<SuccessResponse>('DELETE', `/assets/${id}`),
  assetUrl: (id: string) => `${API_BASE}/assets/${id}/file`,

  // ── Settings ───────────────────────────────────────────────────────────────
  getSettings: () => request<SettingsResponse>('GET', '/settings'),
  saveSettings: (data: Partial<Settings>) => request<SuccessResponse>('PUT', '/settings', data),

  // ── LLM Profiles ───────────────────────────────────────────────────────────
  getProfiles: () => request<{ profiles: (LLMProfile & { api_key_masked: string })[]; activeId: string }>('GET', '/settings/profiles'),
  saveProfile: (profile: LLMProfile) => request<{ success: boolean; profile: LLMProfile }>('PUT', '/settings/profiles', profile),
  deleteProfile: (id: string) => request<SuccessResponse>('DELETE', `/settings/profiles/${id}`),
  setActiveProfile: (id: string) => request<SuccessResponse>('PUT', '/settings/profiles/active', { id }),

  // ── AI ─────────────────────────────────────────────────────────────────────
  generate: (data: AIGenerateParams) => request<{ content: string }>('POST', '/ai/generate', data),
  generateImg: (data: AIImageParams) => request<{ asset: Asset }>('POST', '/ai/image', data),
  getChatHistory: (pageId: string) => request<{ messages: ChatMessage[] }>('GET', `/ai/chat/history?page_id=${pageId}`),
  deleteChatHistory: (pageId: string) => request<{ ok: boolean }>('DELETE', `/ai/chat/history?page_id=${pageId}`),

  // Streaming chat — Server-Sent Events via fetch
  async chatStream(
    messages: LLMMessage[],
    pageId: string | null,
    pageContent: string | null,
    { onChunk, onDone, onError }: ChatStreamCallbacks
  ): Promise<void> {
    try {
      const res = await fetch(`${API_BASE}/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Project-Id': _currentProjectId,
        },
        body: JSON.stringify({ messages, page_id: pageId, page_content: pageContent }),
      });
      if (res.status === 401 || res.status === 403) {
        handleAuthFailure();
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string };
        onError(err.error ?? 'Chat failed');
        return;
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6)) as { type: string; text?: string; error?: string };
            if (data.type === 'chunk' && data.text) onChunk(data.text);
            else if (data.type === 'done') onDone();
            else if (data.type === 'error') onError(data.error ?? 'Unknown error');
          } catch { /* malformed SSE line */ }
        }
      }
    } catch (err) {
      onError((err as Error).message);
    }
  },
};
