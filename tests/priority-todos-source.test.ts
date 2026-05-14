import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/client/app.ts', import.meta.url), 'utf8');

test('folder todo saves refresh only the todo section instead of rerendering the page', () => {
  const saveFolderTodos = extractFunctionBody('saveFolderTodos');

  assert.doesNotMatch(saveFolderTodos, /renderPage\(/);
  assert.match(source, /refreshPriorityTodoSection/);
});

test('priority todo cards expose drag targets and draggable tasks', () => {
  assert.match(source, /setupPriorityTodoDragAndDrop/);
  assert.match(source, /data-priority=/);
  assert.match(source, /data-todo-id=/);
  assert.match(source, /draggable="true"/);
});

test('priority todo text can be edited from the task card', () => {
  assert.match(source, /function editPriorityTodo/);
  assert.match(source, /priority-text-btn/);
  assert.match(source, /onclick="editPriorityTodo/);
});

function extractFunctionBody(name: string): string {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} function should exist`);

  const nextFunction = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, nextFunction === -1 ? undefined : nextFunction);
}
