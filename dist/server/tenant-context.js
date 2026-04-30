// src/server/tenant-context.ts
// Resolves the data directory for the current request.
// - Self-hosted: returns the global DATA_DIR (same as before)
// - Cloud: returns /app/data/<tenant_id>/ based on JWT identity
import path from 'path';
const CLOUD_ENABLED = process.env.YOINKO_CLOUD === 'true';
// Base data dir (self-hosted default)
const isCompiled = (typeof __dirname !== 'undefined' ? __dirname : '').includes('/dist');
const DEFAULT_DATA_DIR = process.env.YOINKO_DATA_DIR
    || path.join(process.cwd(), 'data');
// Cloud root: all tenants live under this
const CLOUD_DATA_ROOT = process.env.YOINKO_DATA_DIR || '/app/data';
/**
 * Get the data directory for the current request.
 * In self-hosted mode, always returns the global DATA_DIR.
 * In cloud mode, returns the tenant-specific directory from req.tenantDataDir.
 */
export function getDataDir(req) {
    if (!CLOUD_ENABLED || !req) {
        return DEFAULT_DATA_DIR;
    }
    const tenantDir = req.tenantDataDir;
    if (!tenantDir) {
        // Fallback — should not happen if cloudAuth middleware ran
        return DEFAULT_DATA_DIR;
    }
    return tenantDir;
}
/** Self-hosted static DATA_DIR for boot-time operations */
export const STATIC_DATA_DIR = DEFAULT_DATA_DIR;
export { CLOUD_ENABLED, CLOUD_DATA_ROOT };
//# sourceMappingURL=tenant-context.js.map