// src/server/ai/index.ts — Unified AI adapter
// Supports: OpenAI, Google Gemini, Anthropic Claude, OpenAI-Compatible
import { getGlobalDb } from '../db.js';
import type { LLMMessage, AIOptions, ImageResult, Settings, LLMProfile } from '../../shared/types.js';

function getSettings(dataDir?: string): Settings {
  const db = getGlobalDb(dataDir);
  const rows = db.prepare<[], { key: string; value: string }>(`SELECT key, value FROM settings`).all();
  const s: Record<string, string> = {};
  rows.forEach((r: { key: string; value: string }) => { s[r.key] = r.value; });

  // Try to read the active LLM profile (multi-profile mode)
  try {
    const profilesRaw = s.llm_profiles;
    const activeId = s.llm_active_profile;
    if (profilesRaw && activeId) {
      const profiles = JSON.parse(profilesRaw) as LLMProfile[];
      const active = profiles.find(p => p.id === activeId);
      if (active) {
        // Overlay profile values onto settings
        s.llm_provider = active.provider;
        s.llm_model = active.model;
        s.llm_api_key = active.api_key;
        s.llm_base_url = active.base_url;
        s.image_model = active.image_model;
      }
    }
  } catch { /* profile parse error — use legacy keys */ }

  return s as Settings;
}

// ── Text generation ───────────────────────────────────────────────────────────
export async function generateText(messages: LLMMessage[], opts: AIOptions = {}, dataDir?: string): Promise<string> {
  const s = getSettings(dataDir);
  const p = opts.provider ?? s.llm_provider ?? 'openai';
  const key = opts.apiKey ?? s.llm_api_key ?? '';
  const m = opts.model ?? s.llm_model ?? 'gpt-4o-mini';
  const url = opts.baseUrl ?? s.llm_base_url ?? '';

  switch (p) {
    case 'openai':
    case 'openai-compatible':
      return callOpenAI(messages, key, m, url || null);
    case 'gemini':
      return callGemini(messages, key, m);
    case 'claude':
      return callClaude(messages, key, m);
    default:
      throw new Error(`Unknown provider: ${p}`);
  }
}

// ── Streaming text generation ─────────────────────────────────────────────────
export async function* streamText(messages: LLMMessage[], opts: AIOptions = {}, dataDir?: string): AsyncGenerator<string> {
  const s = getSettings(dataDir);
  const p = opts.provider ?? s.llm_provider ?? 'openai';
  const key = opts.apiKey ?? s.llm_api_key ?? '';
  const m = opts.model ?? s.llm_model ?? 'gpt-4o-mini';
  const url = opts.baseUrl ?? s.llm_base_url ?? '';

  switch (p) {
    case 'openai':
    case 'openai-compatible':
      yield* streamOpenAI(messages, key, m, url || null);
      break;
    case 'gemini':
      yield* streamGemini(messages, key, m);
      break;
    case 'claude':
      yield* streamClaude(messages, key, m);
      break;
    default:
      throw new Error(`Unknown provider: ${p}`);
  }
}

// ── Image generation ──────────────────────────────────────────────────────────
export async function generateImage(prompt: string, dataDir?: string): Promise<ImageResult> {
  const s = getSettings(dataDir);
  const key = s.llm_api_key ?? '';
  const provider = s.llm_provider ?? 'openai';
  const baseUrl = s.llm_base_url ?? '';
  const imageModel = s.image_model || '';

  switch (provider) {
    case 'gemini':
      return generateImageGemini(prompt, key, imageModel);

    case 'claude':
      throw new Error('Claude (Anthropic) does not support image generation. Switch to an OpenAI or Gemini profile, or use an OpenAI-compatible provider.');

    case 'openai-compatible':
      return generateImageOpenAI(prompt, key, imageModel || 'dall-e-3', baseUrl || null);

    case 'openai':
    default:
      return generateImageOpenAI(prompt, key, imageModel || 'dall-e-3', null);
  }
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function callOpenAI(messages: LLMMessage[], apiKey: string, model: string, baseUrl: string | null): Promise<string> {
  const { OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  const res = await client.chat.completions.create({ model, messages });
  return res.choices[0].message.content ?? '';
}

async function* streamOpenAI(messages: LLMMessage[], apiKey: string, model: string, baseUrl: string | null): AsyncGenerator<string> {
  const { OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  const stream = await client.chat.completions.create({ model, messages, stream: true });
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield text;
  }
}

async function generateImageOpenAI(prompt: string, apiKey: string, model: string, baseUrl: string | null): Promise<ImageResult> {
  const { OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });

  const isDallE = model.startsWith('dall-e');
  // DALL-E supports response_format, n, size; newer models (gpt-image-1) don't
  const params: Record<string, unknown> = {
    model: model ?? 'dall-e-3',
    prompt,
    ...(isDallE ? { n: 1, size: '1024x1024', response_format: 'url' as const } : { size: '1024x1024' }),
  };

  const res = await client.images.generate(params as unknown as Parameters<typeof client.images.generate>[0]);

  // Newer models may return base64 in b64_json field
  const item = res.data?.[0];
  if (item?.url) {
    return { url: item.url, revised_prompt: item.revised_prompt ?? undefined };
  }
  if (item?.b64_json) {
    return { base64: item.b64_json, mimeType: 'image/png' };
  }
  throw new Error('OpenAI did not return an image');
}

// ── Google Gemini ─────────────────────────────────────────────────────────────
async function callGemini(messages: LLMMessage[], apiKey: string, model: string): Promise<string> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const m = genAI.getGenerativeModel({ model: model ?? 'gemini-2.0-flash' });

  const systemParts = messages.filter(x => x.role === 'system').map(x => x.content).join('\n');
  const chatHistory = messages
    .filter(x => x.role !== 'system')
    .slice(0, -1)
    .map(x => ({ role: x.role === 'assistant' ? 'model' as const : 'user' as const, parts: [{ text: x.content }] }));
  const lastMsg = messages.filter(x => x.role !== 'system').at(-1)?.content ?? '';

  const chat = m.startChat({
    history: chatHistory,
    ...(systemParts ? { systemInstruction: { role: 'user' as const, parts: [{ text: systemParts }] } } : {}),
  });
  const result = await chat.sendMessage(lastMsg);
  return result.response.text();
}

async function* streamGemini(messages: LLMMessage[], apiKey: string, model: string): AsyncGenerator<string> {
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const m = genAI.getGenerativeModel({ model: model ?? 'gemini-2.0-flash' });

  const systemParts = messages.filter(x => x.role === 'system').map(x => x.content).join('\n');
  const chatHistory = messages
    .filter(x => x.role !== 'system')
    .slice(0, -1)
    .map(x => ({ role: x.role === 'assistant' ? 'model' as const : 'user' as const, parts: [{ text: x.content }] }));
  const lastMsg = messages.filter(x => x.role !== 'system').at(-1)?.content ?? '';

  const chat = m.startChat({
    history: chatHistory,
    ...(systemParts ? { systemInstruction: { role: 'user' as const, parts: [{ text: systemParts }] } } : {}),
  });
  const result = await chat.sendMessageStream(lastMsg);
  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) yield text;
  }
}

async function generateImageGemini(prompt: string, apiKey: string, imageModel: string): Promise<ImageResult> {
  const model = imageModel || 'gemini-2.0-flash-exp-image-generation';

  // Legacy Imagen models use the REST predict API
  if (model.startsWith('imagen')) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${apiKey}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1 },
      }),
    });
    const json = await res.json() as { error?: { message?: string }; predictions?: Array<{ bytesBase64Encoded?: string }> };
    if (!res.ok) throw new Error(json.error?.message ?? 'Gemini Imagen generation failed');
    const b64 = json.predictions?.[0]?.bytesBase64Encoded;
    return { base64: b64, mimeType: 'image/png' };
  }

  // Gemini generative models (e.g. gemini-2.0-flash, gemini-3.1-flash-image-preview)
  // use the standard generateContent API with responseModalities including "image"
  const { GoogleGenerativeAI } = await import('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const m = genAI.getGenerativeModel({
    model,
    generationConfig: {
      // @ts-expect-error — responseModalities is valid for image-capable models
      responseModalities: ['TEXT', 'IMAGE'],
    },
  });

  const result = await m.generateContent(prompt);
  const parts = result.response.candidates?.[0]?.content?.parts ?? [];

  for (const part of parts) {
    if ((part as any).inlineData) {
      const data = (part as any).inlineData;
      return { base64: data.data, mimeType: data.mimeType || 'image/png' };
    }
  }

  throw new Error('Gemini did not return an image. Make sure your model supports image generation.');
}

// ── Anthropic Claude ──────────────────────────────────────────────────────────
async function callClaude(messages: LLMMessage[], apiKey: string, model: string): Promise<string> {
  const Anthropic = await import('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey });

  const system = messages.filter(x => x.role === 'system').map(x => x.content).join('\n');
  const msgs = messages.filter(x => x.role !== 'system') as Array<{ role: 'user' | 'assistant'; content: string }>;

  const res = await client.messages.create({
    model: model ?? 'claude-3-5-haiku-20241022',
    max_tokens: 4096,
    ...(system ? { system } : {}),
    messages: msgs,
  });
  return (res.content[0] as { text: string }).text;
}

async function* streamClaude(messages: LLMMessage[], apiKey: string, model: string): AsyncGenerator<string> {
  const Anthropic = await import('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey });

  const system = messages.filter(x => x.role === 'system').map(x => x.content).join('\n');
  const msgs = messages.filter(x => x.role !== 'system') as Array<{ role: 'user' | 'assistant'; content: string }>;

  const stream = await client.messages.stream({
    model: model ?? 'claude-3-5-haiku-20241022',
    max_tokens: 4096,
    ...(system ? { system } : {}),
    messages: msgs,
  });
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
      yield chunk.delta.text;
    }
  }
}
