#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '../src/client/app.ts');
let src = fs.readFileSync(file, 'utf8');
const lines = src.split('\n');

// Find tiptapToMarkdown start/end line indices (0-based)
const tmStart = lines.findIndex(l => l === 'function tiptapToMarkdown(doc: TipTapDoc): string {');
if (tmStart === -1) { console.error('Cannot find tiptapToMarkdown'); process.exit(1); }

// Walk forward to find matching closing brace at depth 0
function findFunctionEnd(lines, startIdx) {
  let depth = 0;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) return i; }
    }
  }
  return -1;
}

const tmEnd = findFunctionEnd(lines, tmStart);
if (tmEnd === -1) { console.error('Cannot find tiptapToMarkdown end'); process.exit(1); }

// Find renderMarkdown start/end
const rmStart = lines.findIndex(l => l === 'function renderMarkdown(text: string): string {');
if (rmStart === -1) { console.error('Cannot find renderMarkdown'); process.exit(1); }
const rmEnd = findFunctionEnd(lines, rmStart);
if (rmEnd === -1) { console.error('Cannot find renderMarkdown end'); process.exit(1); }

console.log(`tiptapToMarkdown: lines ${tmStart+1}–${tmEnd+1}`);
console.log(`renderMarkdown:   lines ${rmStart+1}–${rmEnd+1}`);

// ── New tiptapToMarkdown ─────────────────────────────────────────────────────
const NEW_TIPTAP_TO_MD = `function tiptapToMarkdown(doc: TipTapDoc): string {
  // ── Inline (marks) ────────────────────────────────────────────────────────
  function inline(nodes?: TipTapDoc[]): string {
    if (!nodes) return '';
    return nodes.map(n => {
      if (n.type === 'hardBreak') return '  \\n';
      let t = n.text || '';
      if (n.marks) {
        // code mark: no inner markdown, return immediately
        if (n.marks.some(m => m.type === 'code')) return \`\\\`\${t}\\\`\`;
        n.marks.forEach(m => {
          if      (m.type === 'bold')      t = \`**\${t}**\`;
          else if (m.type === 'italic')    t = \`*\${t}*\`;
          else if (m.type === 'strike')    t = \`~~\${t}~~\`;
          else if (m.type === 'underline') t = \`<u>\${t}</u>\`;
          else if (m.type === 'link')      t = \`[\${t}](\${(m.attrs?.href as string) || ''})\`;
        });
      }
      return t;
    }).join('');
  }

  // ── List item ─────────────────────────────────────────────────────────────
  function serializeListItem(node: TipTapDoc, prefix: string): string {
    const c = node.content || [];
    if (c.length === 0) return prefix + '\\n';
    const first = c[0];
    const textLine = first.type === 'paragraph'
      ? inline(first.content).trimEnd()
      : blk(first).trimEnd();
    // Nested lists indented by 4 spaces
    const nested = c.slice(1).map(n => blk(n).replace(/^(?=.)/gm, '    ')).join('');
    return prefix + textLine + '\\n' + nested;
  }

  // ── Block ─────────────────────────────────────────────────────────────────
  function blk(node: TipTapDoc): string {
    const t = node.type;
    const c = node.content || [];

    if (t === 'doc') return c.map(n => blk(n)).join('\\n');
    if (t === 'paragraph') return inline(c) + '\\n';
    if (t === 'heading') return '#'.repeat((node.attrs?.level as number) || 1) + ' ' + inline(c) + '\\n';
    if (t === 'horizontalRule') return '---\\n';

    if (t === 'codeBlock') {
      const lang = (node.attrs?.language as string) || '';
      const code = c.map(n => n.text || '').join('');
      return \`\\\`\\\`\\\`\${lang}\\n\${code}\\n\\\`\\\`\\\`\\n\`;
    }

    if (t === 'blockquote') {
      return c.map(n => blk(n).replace(/^/gm, '> ').replace(/> $/gm, '>').trimEnd())
              .join('\\n') + '\\n';
    }

    if (t === 'bulletList')  return c.map(n => serializeListItem(n, '- ')).join('');
    if (t === 'orderedList') {
      let i = (node.attrs?.start as number) || 1;
      return c.map(n => serializeListItem(n, \`\${i++}. \`)).join('');
    }

    if (t === 'taskList') {
      return c.map(n => {
        const checked  = n.attrs?.checked;
        const checkbox = checked ? '[x]' : '[ ]';
        const children = n.content || [];
        const first    = children[0];
        const textPart = first
          ? (first.type === 'paragraph' ? inline(first.content).trimEnd() : blk(first).trimEnd())
          : '';
        const nested = children.slice(1).map(n2 => blk(n2).replace(/^(?=.)/gm, '    ')).join('');
        return \`- \${checkbox} \${textPart}\\n\${nested}\`;
      }).join('');
    }

    if (t === 'hardBreak') return '  \\n';
    if (t === 'text')      return node.text || '';

    if (t === 'table') {
      const rows = c.map((row, rowIdx) => {
        const cells = (row.content || []).map(cell => {
          return (cell.content || []).map(n => blk(n)).join('').replace(/\\n/g, ' ').trim();
        });
        const rowStr = '| ' + cells.join(' | ') + ' |';
        if (rowIdx === 0) {
          const sep = '| ' + cells.map(() => '----------').join(' | ') + ' |';
          return rowStr + '\\n' + sep;
        }
        return rowStr;
      });
      return rows.join('\\n') + '\\n';
    }

    return c.map(n => blk(n)).join('');
  }

  try {
    return blk(doc).replace(/\\n{3,}/g, '\\n\\n').trimEnd() + '\\n';
  } catch {
    return '';
  }
}`;

// ── New renderMarkdown ───────────────────────────────────────────────────────
const NEW_RENDER_MD = `function renderMarkdown(text: string): string {
  if (typeof marked === 'undefined') return \`<pre>\${esc(text || '')}</pre>\`;
  const result = marked.parse(text || '', { async: false, gfm: true, breaks: false });
  const html = typeof result === 'string' ? result : \`<pre>\${esc(text || '')}</pre>\`;

  // Convert marked's GFM checkbox output to TipTap taskList/taskItem.
  // marked produces:
  //   tight: <ul>\\n<li><input type="checkbox" disabled=""> text</li>\\n</ul>
  //   loose: <ul>\\n<li><input ...> <p>text</p>\\n</li>\\n</ul>
  return html.replace(
    /<ul[^>]*>([\\\s\\\S]*?)<\\/ul>/g,
    (fullMatch, inner) => {
      if (!/<input[^>]+type="checkbox"/.test(inner)) return fullMatch;
      const converted = inner.replace(
        /<li>([\\\s\\\S]*?)<\\/li>/g,
        (_m: string, content: string) => {
          const cbMatch = content.match(/<input([^>]*)type="checkbox"([^>]*)>/);
          if (!cbMatch) return \`<li>\${content}</li>\`;
          const allAttrs = (cbMatch[1] || '') + (cbMatch[2] || '');
          const isChecked = /checked/.test(allAttrs);
          let itemHtml = content.replace(/<input[^>]+type="checkbox"[^>]*>/g, '').trim();
          // Unwrap loose <p> wrapper if present
          itemHtml = itemHtml.replace(/^<p>([\\\s\\\S]*?)<\\/p>$/, '$1').trim();
          return \`<li data-type="taskItem" \${isChecked ? 'data-checked="true"' : 'data-checked="false"'}>\` +
                 \`<label><input type="checkbox" \${isChecked ? 'checked' : ''}><span>\${itemHtml}</span></label></li>\`;
        }
      );
      return \`<ul data-type="taskList">\${converted}</ul>\`;
    }
  );
}`;

// Splice new functions in
const before = lines.slice(0, tmStart);
const between = lines.slice(tmEnd + 1, rmStart);
const after = lines.slice(rmEnd + 1);

const newLines = [
  ...before,
  NEW_TIPTAP_TO_MD,
  ...between,
  NEW_RENDER_MD,
  ...after,
];

fs.writeFileSync(file, newLines.join('\n'), 'utf8');
console.log('✅ tiptapToMarkdown and renderMarkdown patched');
