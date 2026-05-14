import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const clientSource = readFileSync(new URL('../src/client/app.ts', import.meta.url), 'utf8');
const pagesRouteSource = readFileSync(new URL('../src/server/routes/pages.ts', import.meta.url), 'utf8');

test('diagram and kanban tool shells use the page display name as their title', () => {
  const diagramEditor = extractFunctionBody(clientSource, 'renderDiagramEditor');
  const kanbanEditor = extractFunctionBody(clientSource, 'renderKanbanEditor');

  assert.match(clientSource, /function toolPageTitle\(page: PageNode\): string/);
  assert.match(diagramEditor, /renderToolShell\(container, toolPageTitle\(page\), locked/);
  assert.match(kanbanEditor, /renderToolShell\(container, toolPageTitle\(page\), locked/);
});

test('renaming tool pages preserves compound JSON page extensions', () => {
  const renameBranch = pagesRouteSource.slice(
    pagesRouteSource.indexOf('if (name !== undefined)'),
    pagesRouteSource.indexOf('if (content !== undefined)'),
  );

  assert.match(pagesRouteSource, /pageFileType/);
  assert.match(renameBranch, /extensionForFileType\(existingFileType/);
  assert.doesNotMatch(renameBranch, /path\.extname\(relPath\)/);
});

function extractFunctionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} function should exist`);

  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, nextFunction === -1 ? undefined : nextFunction);
}
