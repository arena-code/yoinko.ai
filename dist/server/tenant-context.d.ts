import type { Request } from 'express';
declare const CLOUD_ENABLED: boolean;
declare const CLOUD_DATA_ROOT: string;
/**
 * Get the data directory for the current request.
 * In self-hosted mode, always returns the global DATA_DIR.
 * In cloud mode, returns the tenant-specific directory from req.tenantDataDir.
 */
export declare function getDataDir(req?: Request): string;
/** Self-hosted static DATA_DIR for boot-time operations */
export declare const STATIC_DATA_DIR: string;
export { CLOUD_ENABLED, CLOUD_DATA_ROOT };
//# sourceMappingURL=tenant-context.d.ts.map