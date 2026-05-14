import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/client/app.ts', import.meta.url), 'utf8');

test('folder page view includes all tool file formats', () => {
  const folderView = extractFunctionBody('renderFolderView');

  assert.match(folderView, /toolPages/);
  assert.match(folderView, /file_type === 'diagram'/);
  assert.match(folderView, /file_type === 'kanban'/);
  assert.match(folderView, /file_type === 'sheet'/);
  assert.match(folderView, /section\('Tools'/);
});

test('upload zone treats tool JSON files as page files', () => {
  assert.match(source, /isPageUploadFile/);
  assert.match(source, /\.diagram\.json/);
  assert.match(source, /\.kanban\.json/);
  assert.match(source, /\.sheet\.json/);
});

function extractFunctionBody(name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} function should exist`);

  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, nextFunction === -1 ? undefined : nextFunction);
}
