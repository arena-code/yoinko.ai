import Database from 'better-sqlite3';
import { DATA_DIR } from './projects.js';
export declare const globalDb: Database.Database;
export declare function getProjectDb(projectId?: string): Database.Database;
export { DATA_DIR };
export declare function evictProjectDb(projectId: string): void;
//# sourceMappingURL=db.d.ts.map