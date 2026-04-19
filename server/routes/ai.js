// server/routes/ai.js
const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const { db, UPLOADS_DIR } = require('../db');
const { generateText, streamText, generateImage } = require('../ai');

const now = () => new Date().toISOString();

// ── POST /api/ai/generate — one-shot content generation ──────────────────────
router.post('/generate', async (req, res) => {
  try {
    const { prompt, context, type = 'md' } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const systemPrompt = type === 'md'
      ? `You are a helpful writing assistant. Generate well-structured, informative Markdown content based on the user's prompt. Return ONLY the markdown content, no explanation.`
      : `You are a helpful writing assistant. Generate clean, self-contained HTML content (body content only, no <html>/<head>/<body> tags) based on the user's prompt. Return ONLY the HTML content, no explanation.`;

    const messages = [
      { role: 'system', content: systemPrompt },
      ...(context ? [{ role: 'system', content: `Current page context:\n${context}` }] : []),
      { role: 'user', content: prompt }
    ];

    const content = await generateText(messages);
    res.json({ content });
  } catch (err) {
    console.error('AI generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/ai/chat — streaming chat (SSE) ──────────────────────────────────
router.post('/chat', async (req, res) => {
  const { messages, page_id, page_content } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages array required' });
  }

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  try {
    const systemMsg = {
      role: 'system',
      content: `You are a helpful AI assistant embedded in Notas, a knowledge base app. Be concise and helpful.${page_content ? `\n\nCurrent page content for context:\n${page_content.slice(0, 3000)}` : ''}`
    };

    const fullMessages = [systemMsg, ...messages];
    let fullReply = '';

    for await (const chunk of streamText(fullMessages)) {
      fullReply += chunk;
      send({ type: 'chunk', text: chunk });
    }

    // Persist messages to DB if page_id provided
    if (page_id) {
      const lastUser = messages.at(-1);
      if (lastUser?.role === 'user') {
        db.prepare(`INSERT INTO chat_messages (id, page_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
          .run(uuidv4(), page_id, 'user', lastUser.content, now());
      }
      db.prepare(`INSERT INTO chat_messages (id, page_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(uuidv4(), page_id, 'assistant', fullReply, now());
    }

    send({ type: 'done' });
    res.end();
  } catch (err) {
    console.error('AI chat error:', err.message);
    send({ type: 'error', error: err.message });
    res.end();
  }
});

// ── POST /api/ai/image — generate an image ────────────────────────────────────
router.post('/image', async (req, res) => {
  try {
    const { prompt, page_id } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const result = await generateImage(prompt);

    // If we get a URL (OpenAI), download and save it
    if (result.url) {
      const resp = await fetch(result.url);
      const buffer = Buffer.from(await resp.arrayBuffer());
      const filename = `${uuidv4()}.png`;
      const filePath = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(filePath, buffer);

      const id = uuidv4();
      const ts = now();
      db.prepare(`INSERT INTO assets (id, page_id, filename, original_name, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, page_id || null, filename, `ai-${filename}`, 'image/png', buffer.length, ts);

      return res.json({ asset: { id, filename, url: `/api/assets/${id}/file`, original_name: `ai-${filename}`, mime_type: 'image/png' } });
    }

    // If we get base64 (Gemini)
    if (result.base64) {
      const buffer = Buffer.from(result.base64, 'base64');
      const filename = `${uuidv4()}.png`;
      const filePath = path.join(UPLOADS_DIR, filename);
      fs.writeFileSync(filePath, buffer);

      const id = uuidv4();
      const ts = now();
      db.prepare(`INSERT INTO assets (id, page_id, filename, original_name, mime_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, page_id || null, filename, `ai-image-${Date.now()}.png`, 'image/png', buffer.length, ts);

      return res.json({ asset: { id, filename, url: `/api/assets/${id}/file`, original_name: `ai-image.png`, mime_type: 'image/png' } });
    }

    res.status(500).json({ error: 'Unknown image format from provider' });
  } catch (err) {
    console.error('AI image error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ai/chat/history?page_id=:id ─────────────────────────────────────
router.get('/chat/history', (req, res) => {
  try {
    const { page_id } = req.query;
    if (!page_id) return res.json({ messages: [] });
    const messages = db.prepare(`SELECT * FROM chat_messages WHERE page_id = ? ORDER BY created_at ASC`).all(page_id);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
