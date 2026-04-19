import type { PageNode } from '../shared/types.js';
export declare const PAGES_DIR: string;
export declare function toId(relPath: string): string;
export declare function fromId(id: string): string;
export declare function scanDir(baseDir?: string, relDir?: string): PageNode[];
export declare function flattenTree(tree: PageNode[], parentId?: string | null): PageNode[];
export declare function readPage(relPath: string): string;
export declare function writePage(relPath: string, content: string): void;
export declare function createPage(relPath: string, content?: string): void;
export declare function createFolder(relPath: string): void;
export declare function deletePath(relPath: string): void;
export declare function renamePath(oldRelPath: string, newName: string): string;
//# sourceMappingURL=files.d.ts.map