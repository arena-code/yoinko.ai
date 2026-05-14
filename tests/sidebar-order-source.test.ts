import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/client/app.ts', import.meta.url), 'utf8');

test('sidebar orders sibling items as folders first, then files, alphabetically', () => {
  const renderSidebar = extractFunctionBody('renderSidebar');

  assert.match(source, /function compareSidebarNavNodes\(a: NavPageNode, b: NavPageNode\): number/);
  assert.match(renderSidebar, /Object\.values\(map\)\.forEach\(page => page\._children\.sort\(compareSidebarNavNodes\)\)/);
});

function extractFunctionBody(name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} function should exist`);

  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, nextFunction === -1 ? undefined : nextFunction);
}
