import type { Project } from '../shared/types.js';
export declare const DATA_DIR: string;
export declare function listProjects(dataDir?: string): Project[];
export declare function getProject(id: string, dataDir?: string): Project | undefined;
export declare function createProject(name: string, dataDir?: string): Project;
export declare function renameProject(id: string, name: string, dataDir?: string): Project;
export declare function reorderProjects(ids: string[], dataDir?: string): Project[];
export declare function setProjectLogo(id: string, filename: string, dataDir?: string): Project;
export declare function clearProjectLogo(id: string, dataDir?: string): Project;
export declare function getProjectLogoPath(id: string, dataDir?: string): string | null;
export declare function deleteProject(id: string, dataDir?: string): void;
export interface ProjectDirs {
    pagesDir: string;
    uploadsDir: string;
    dbPath: string;
}
export declare function getProjectDirs(id: string, dataDir?: string): ProjectDirs;
export declare function migrateOnStartup(): void;
//# sourceMappingURL=projects.d.ts.map