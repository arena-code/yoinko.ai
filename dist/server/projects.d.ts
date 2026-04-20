export declare const DATA_DIR: string;
export interface Project {
    id: string;
    name: string;
    created_at: string;
}
export declare function listProjects(): Project[];
export declare function getProject(id: string): Project | undefined;
export declare function createProject(name: string): Project;
export declare function renameProject(id: string, name: string): Project;
export declare function deleteProject(id: string): void;
export interface ProjectDirs {
    pagesDir: string;
    uploadsDir: string;
    dbPath: string;
}
export declare function getProjectDirs(id: string): ProjectDirs;
export declare function migrateOnStartup(): void;
//# sourceMappingURL=projects.d.ts.map