// src/server/middleware/workspace-auth.ts
import type { Request, Response, NextFunction } from 'express';
import { getGlobalDb } from '../db.js';

const CLOUD_ENABLED = process.env.YOINKO_CLOUD === 'true';

export function workspaceAccessCheck(req: Request, res: Response, next: NextFunction): void {
  if (!CLOUD_ENABLED) return next();
  const isOwner = (req as any).isOwner ?? true;
  if (isOwner) return next();
  const user = (req as any).user as { id: string } | undefined;
  if (!user) return next();
  const dd = (req as any).tenantDataDir as string | undefined;
  if (!dd) return next();
  const pid = (req.headers['x-project-id'] as string) || 'default';
  const db = getGlobalDb(dd);
  const row = db.prepare<[string, string], { role: string }>(
    'SELECT role FROM workspace_access WHERE project_id = ? AND user_id = ?'
  ).get(pid, user.id);
  if (!row) {
    res.status(403).json({ error: 'You do not have access to this workspace.' });
    return;
  }
  (req as any).workspaceRole = row.role;
  const isAiRoute = req.baseUrl?.includes('/ai');
  const isMutation = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  if (row.role === 'read' && isMutation && !isAiRoute) {
    res.status(403).json({ error: 'You have read-only access to this workspace.' });
    return;
  }
  next();
}
