import Database from 'better-sqlite3';
import { DATA_DIR } from './projects.js';
/**
 * Get the global settings DB.
 * In self-hosted mode: returns the singleton global.db
 * In cloud mode: returns the tenant's global.db (from req.tenantDataDir)
 */
export declare function getGlobalDb(dataDir?: string): Database.Database;
export declare function getProjectDb(projectId?: string, dataDir?: string): Database.Database;
export { DATA_DIR };
export declare function evictProjectDb(projectId: string, dataDir?: string): void;
//# sourceMappingURL=db.d.ts.map