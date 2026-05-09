// src/server/routes/storage.ts
import express, { Request, Response } from 'express';
import { getTenantUsedBytes, getStorageLimit, getWorkspaceLimit } from '../storage.js';
import { dataDir } from '../request-helpers.js';

const router = express.Router();
const CLOUD_ENABLED = process.env.YOINKO_CLOUD === 'true';

// GET /api/storage/usage
router.get('/usage', (req: Request, res: Response) => {
  const dd = dataDir(req);
  const plan = (req as any).tenantPlan || 'basic';
  const used = dd ? getTenantUsedBytes(dd) : 0;
  res.json({
    usage: {
      used,
      limit: getStorageLimit(plan),
      workspaceLimit: getWorkspaceLimit(plan),
      isCloud: CLOUD_ENABLED,
    },
  });
});

export default router;
