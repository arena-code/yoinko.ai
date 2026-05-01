// src/server/tenant-context.ts
// Resolves the data directory for the current request.
// - Self-hosted: returns the global DATA_DIR (same as before)
// - Cloud: returns /app/data/<tenant_id>/ based on JWT identity

import path from 'path';

const CLOUD_ENABLED = process.env.YOINKO_CLOUD === 'true';

// Base data dir (self-hosted default)
const DEFAULT_DATA_DIR = process.env.YOINKO_DATA_DIR
  || path.join(process.cwd(), 'data');

// Cloud root: all tenants live under this
const CLOUD_DATA_ROOT = process.env.YOINKO_DATA_DIR || '/app/data';

export { DEFAULT_DATA_DIR, CLOUD_ENABLED, CLOUD_DATA_ROOT };
