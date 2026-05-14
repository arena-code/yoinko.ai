import assert from 'node:assert/strict';
import test from 'node:test';
import type { PageNode } from '../src/shared/types.js';
import {
  canCreateFolderInParent,
  canMovePageToParent,
} from '../src/shared/page-depth.js';

const pages: PageNode[] = [
  page('root-folder', null, 'folder'),
  page('child-folder', 'root-folder', 'folder'),
  page('leaf-child-folder', 'root-folder', 'folder'),
  page('deep-folder', 'child-folder', 'folder'),
  page('root-page', null, 'page'),
  page('child-page', 'child-folder', 'page'),
];

test('folders can only be created at root or one level under a root folder', () => {
  assert.equal(canCreateFolderInParent(null, pages), true);
  assert.equal(canCreateFolderInParent('root-folder', pages), true);
  assert.equal(canCreateFolderInParent('child-folder', pages), false);
});

test('folder moves cannot create more than one level of folder nesting', () => {
  assert.equal(canMovePageToParent('child-folder', null, pages), true);
  assert.equal(canMovePageToParent('leaf-child-folder', 'root-folder', pages), true);
  assert.equal(canMovePageToParent('root-folder', 'child-folder', pages), false);
  assert.equal(canMovePageToParent('root-folder', 'root-folder', pages), false);
});

test('content pages can move into child folders', () => {
  assert.equal(canMovePageToParent('root-page', 'child-folder', pages), true);
  assert.equal(canMovePageToParent('child-page', 'root-folder', pages), true);
});

function page(id: string, parentId: string | null, type: 'page' | 'folder'): PageNode {
  return {
    id,
    path: id,
    name: id,
    display_name: id,
    num: null,
    type,
    parent_id: parentId,
    child_count: 0,
    created_at: '',
    updated_at: '',
  };
}
