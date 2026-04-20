import type { PageNode } from '../shared/types.js';
export declare function getPagesDir(projectId?: string): string;
export declare function toId(relPath: string): string;
export declare function fromId(id: string): string;
export declare function scanDir(baseDir: string, relDir?: string): PageNode[];
export declare function flattenTree(tree: PageNode[], parentId?: string | null): PageNode[];
export declare function readPage(pagesDir: string, relPath: string): string;
export declare function writePage(pagesDir: string, relPath: string, content: string): void;
export declare function createPage(pagesDir: string, relPath: string, content?: string): void;
export declare function createFolder(pagesDir: string, relPath: string): void;
export declare function deletePath(pagesDir: string, relPath: string): void;
export declare function renamePath(pagesDir: string, oldRelPath: string, newName: string): string;
//# sourceMappingURL=files.d.ts.map