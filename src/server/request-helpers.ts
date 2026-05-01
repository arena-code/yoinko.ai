// src/server/request-helpers.ts — Shared route helpers
import type { Request } from 'express';

/** Extract the project ID from the X-Project-Id header (defaults to 'default') */
export function projectId(req: Request): string {
  return (req.headers['x-project-id'] as string) || 'default';
}

/** Get tenant data dir from request (set by cloud-auth middleware) */
export function dataDir(req: Request): string | undefined {
  return (req as any).tenantDataDir;
}
