// public/js/api.js — Thin API client

const API_BASE = '/api';

async function request(method, path, body = null, isFormData = false) {
  const opts = {
    method,
    headers: isFormData ? {} : { 'Content-Type': 'application/json' }
  };
  if (body) {
    opts.body = isFormData ? body : JSON.stringify(body);
  }
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const api = {
  // Pages
  getTree:     ()         => request('GET', '/pages'),
  getFlat:     ()         => request('GET', '/pages/flat'),
  getPage:     (id)       => request('GET', `/pages/${id}`),
  createPage:  (data)     => request('POST', '/pages', data),
  updatePage:  (id, data) => request('PUT', `/pages/${id}`, data),
  deletePage:  (id)       => request('DELETE', `/pages/${id}`),

  // Assets
  uploadFiles: (formData) => request('POST', '/assets/upload', formData, true),
  getAssets:   (pageId)   => request('GET', `/assets${pageId ? `?page_id=${pageId}` : ''}`),
  deleteAsset: (id)       => request('DELETE', `/assets/${id}`),
  assetUrl:    (id)       => `${API_BASE}/assets/${id}/file`,

  // Settings
  getSettings: ()         => request('GET', '/settings'),
  saveSettings:(data)     => request('PUT', '/settings', data),

  // AI
  generate:    (data)     => request('POST', '/ai/generate', data),
  generateImg: (data)     => request('POST', '/ai/image', data),
  getChatHistory:(pageId) => request('GET', `/ai/chat/history?page_id=${pageId}`),

  // Streaming chat — returns EventSource-like via fetch
  async chatStream(messages, pageId, pageContent, onChunk, onDone, onError) {
    try {
      const res = await fetch(`${API_BASE}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages, page_id: pageId, page_content: pageContent })
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        onError(err.error || 'Chat failed');
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          try {
            const data = JSON.parse(line.slice(6));
            if (data.type === 'chunk') onChunk(data.text);
            else if (data.type === 'done') onDone();
            else if (data.type === 'error') onError(data.error);
          } catch {}
        }
      }
    } catch (err) {
      onError(err.message);
    }
  }
};
