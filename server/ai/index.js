// server/ai/index.js — Unified AI adapter
// Supports: OpenAI, Google Gemini, Anthropic Claude, OpenAI-Compatible
const { db } = require('../db');

function getSettings() {
  const rows = db.prepare(`SELECT key, value FROM settings`).all();
  const s = {};
  rows.forEach(r => s[r.key] = r.value);
  return s;
}

// ── Text generation ───────────────────────────────────────────────────────────
async function generateText(messages, { provider, apiKey, model, baseUrl } = {}) {
  const s = getSettings();
  const p = provider || s.llm_provider || 'openai';
  const key = apiKey || s.llm_api_key || '';
  const m = model || s.llm_model || 'gpt-4o-mini';
  const url = baseUrl || s.llm_base_url || '';

  switch (p) {
    case 'openai':
    case 'openai-compatible':
      return await callOpenAI(messages, key, m, url || null);

    case 'gemini':
      return await callGemini(messages, key, m);

    case 'claude':
      return await callClaude(messages, key, m);

    default:
      throw new Error(`Unknown provider: ${p}`);
  }
}

// ── Streaming text generation (returns async generator) ───────────────────────
async function* streamText(messages, { provider, apiKey, model, baseUrl } = {}) {
  const s = getSettings();
  const p = provider || s.llm_provider || 'openai';
  const key = apiKey || s.llm_api_key || '';
  const m = model || s.llm_model || 'gpt-4o-mini';
  const url = baseUrl || s.llm_base_url || '';

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
async function generateImage(prompt) {
  const s = getSettings();
  const key = s.llm_api_key || '';
  const p = s.llm_provider || 'openai';

  if (p === 'gemini') {
    return await generateImageGemini(prompt, key);
  }
  // Default: OpenAI DALL-E
  return await generateImageOpenAI(prompt, key, s.image_model || 'dall-e-3');
}

// ── OpenAI ────────────────────────────────────────────────────────────────────
async function callOpenAI(messages, apiKey, model, baseUrl) {
  const { OpenAI } = require('openai');
  const client = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  const res = await client.chat.completions.create({ model, messages });
  return res.choices[0].message.content;
}

async function* streamOpenAI(messages, apiKey, model, baseUrl) {
  const { OpenAI } = require('openai');
  const client = new OpenAI({ apiKey, ...(baseUrl ? { baseURL: baseUrl } : {}) });
  const stream = await client.chat.completions.create({ model, messages, stream: true });
  for await (const chunk of stream) {
    const text = chunk.choices[0]?.delta?.content;
    if (text) yield text;
  }
}

async function generateImageOpenAI(prompt, apiKey, model) {
  const { OpenAI } = require('openai');
  const client = new OpenAI({ apiKey });
  const res = await client.images.generate({
    model: model || 'dall-e-3',
    prompt,
    n: 1,
    size: '1024x1024',
    response_format: 'url'
  });
  return { url: res.data[0].url, revised_prompt: res.data[0].revised_prompt };
}

// ── Google Gemini ─────────────────────────────────────────────────────────────
async function callGemini(messages, apiKey, model) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const m = genAI.getGenerativeModel({ model: model || 'gemini-2.0-flash' });

  // Convert OpenAI-style messages to Gemini format
  const systemParts = messages.filter(x => x.role === 'system').map(x => x.content).join('\n');
  const chatHistory = messages
    .filter(x => x.role !== 'system')
    .slice(0, -1)
    .map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] }));
  const lastMsg = messages.filter(x => x.role !== 'system').at(-1)?.content || '';

  const chat = m.startChat({
    history: chatHistory,
    ...(systemParts ? { systemInstruction: systemParts } : {})
  });
  const result = await chat.sendMessage(lastMsg);
  return result.response.text();
}

async function* streamGemini(messages, apiKey, model) {
  const { GoogleGenerativeAI } = require('@google/generative-ai');
  const genAI = new GoogleGenerativeAI(apiKey);
  const m = genAI.getGenerativeModel({ model: model || 'gemini-2.0-flash' });

  const systemParts = messages.filter(x => x.role === 'system').map(x => x.content).join('\n');
  const chatHistory = messages
    .filter(x => x.role !== 'system')
    .slice(0, -1)
    .map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] }));
  const lastMsg = messages.filter(x => x.role !== 'system').at(-1)?.content || '';

  const chat = m.startChat({
    history: chatHistory,
    ...(systemParts ? { systemInstruction: systemParts } : {})
  });
  const result = await chat.sendMessageStream(lastMsg);
  for await (const chunk of result.stream) {
    const text = chunk.text();
    if (text) yield text;
  }
}

async function generateImageGemini(prompt, apiKey) {
  // Gemini Imagen — uses the REST API directly
  const url = `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-002:predict?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ prompt }],
      parameters: { sampleCount: 1 }
    })
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Gemini image generation failed');
  const b64 = json.predictions?.[0]?.bytesBase64Encoded;
  return { base64: b64, mimeType: 'image/png' };
}

// ── Anthropic Claude ──────────────────────────────────────────────────────────
async function callClaude(messages, apiKey, model) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey });

  const system = messages.filter(x => x.role === 'system').map(x => x.content).join('\n');
  const msgs = messages.filter(x => x.role !== 'system');

  const res = await client.messages.create({
    model: model || 'claude-3-5-haiku-20241022',
    max_tokens: 4096,
    ...(system ? { system } : {}),
    messages: msgs.map(x => ({ role: x.role, content: x.content }))
  });
  return res.content[0].text;
}

async function* streamClaude(messages, apiKey, model) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic.default({ apiKey });

  const system = messages.filter(x => x.role === 'system').map(x => x.content).join('\n');
  const msgs = messages.filter(x => x.role !== 'system');

  const stream = await client.messages.stream({
    model: model || 'claude-3-5-haiku-20241022',
    max_tokens: 4096,
    ...(system ? { system } : {}),
    messages: msgs.map(x => ({ role: x.role, content: x.content }))
  });
  for await (const chunk of stream) {
    if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
      yield chunk.delta.text;
    }
  }
}

module.exports = { generateText, streamText, generateImage };
