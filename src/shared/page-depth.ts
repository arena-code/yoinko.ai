import type { PageNode } from './types.js';

function byId(pages: PageNode[]): Map<string, PageNode> {
  return new Map(pages.map(p => [p.id, p]));
}

function folderDepth(folderId: string, pages: PageNode[]): number | null {
  const map = byId(pages);
  let page = map.get(folderId);
  if (!page || page.type !== 'folder') return null;

  let depth = 0;
  const seen = new Set<string>();
  while (page.parent_id) {
    if (seen.has(page.id)) return null;
    seen.add(page.id);

    const parent = map.get(page.parent_id);
    if (!parent || parent.type !== 'folder') return null;
    depth++;
    page = parent;
  }
  return depth;
}

function maxFolderDescendantDepth(folderId: string, pages: PageNode[]): number {
  const children = pages.filter(p => p.parent_id === folderId && p.type === 'folder');
  if (!children.length) return 0;
  return Math.max(...children.map(child => 1 + maxFolderDescendantDepth(child.id, pages)));
}

export function canCreateFolderInParent(parentId: string | null, pages: PageNode[]): boolean {
  if (!parentId) return true;
  return folderDepth(parentId, pages) === 0;
}

export function canMovePageToParent(
  pageId: string,
  targetParentId: string | null,
  pages: PageNode[],
): boolean {
  const page = byId(pages).get(pageId);
  if (!page) return false;

  if (targetParentId && folderDepth(targetParentId, pages) === null) return false;
  if (page.type !== 'folder') return true;

  const targetDepth = targetParentId ? folderDepth(targetParentId, pages) : -1;
  if (targetDepth === null) return false;

  const movedFolderDepth = targetDepth + 1;
  return movedFolderDepth + maxFolderDescendantDepth(pageId, pages) <= 1;
}
