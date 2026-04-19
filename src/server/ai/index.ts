// src/server/ai/index.ts — Unified AI adapter
// Supports: OpenAI, Google Gemini, Anthropic Claude, OpenAI-Compatible
import { db } from '../db.js';
import type { LLMMessage, AIOptions, ImageResult, Settings } from '../../shared/types.js';

function getSettings(): Settings {
  const rows = db.prepare<[], { key: string; value: string }>(`SELECT key, value FROM settings`).all();
  const s: Record<string, string> = {};
  rows.forEach(r => { s[r.key] = r.value; });
  return s as Settings;
}

// ── Text generation ───────────────────────────────────────────────────────────
export async function generateText(messages: LLMMessage[], opts: AIOptions = {}): Promise<string> {
  const s = getSettings();
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
export async function* streamText(messages: LLMMessage[], opts: AIOptions = {}): AsyncGenerator<string> {
  const s = getSettings();
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
export async function generateImage(prompt: string): Promise<ImageResult> {
  const s = getSettings();
  const key = s.llm_api_key ?? '';
  const p = s.llm_provider ?? 'openai';
  const baseUrl = s.llm_base_url ?? '';

  if (p === 'gemini') {
    return generateImageGemini(prompt, key);
  }
  return generateImageOpenAI(prompt, key, s.image_model ?? 'dall-e-3', baseUrl || null);
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
  const res = await client.images.generate({
    model: model ?? 'dall-e-3',
    prompt,
    n: 1,
    size: '1024x1024',
    response_format: 'url',
  });
  return { url: res.data?.[0]?.url ?? undefined, revised_prompt: res.data?.[0]?.revised_prompt ?? undefined };
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
    ...(systemParts ? { systemInstruction: systemParts } : {}),
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
    ...(systemParts ? { systemInstruction: systemParts } : {}),
  });
  const result = await chat.sendMessageStream(lastMsg);
  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) yield text;
  }
}

async function generateImageGemini(prompt: string, apiKey: string): Promise<ImageResult> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1 },
    }),
  });
  const json = await res.json() as { error?: { message?: string }; predictions?: Array<{ bytesBase64Encoded?: string }> };
  if (!res.ok) throw new Error(json.error?.message ?? 'Gemini image generation failed');
  const b64 = json.predictions?.[0]?.bytesBase64Encoded;
  return { base64: b64, mimeType: 'image/png' };
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
