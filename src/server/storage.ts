// src/server/storage.ts — Storage quota helpers (cloud mode only)
import { listProjects } from './projects.js';
import { getProjectDb } from './db.js';

export const PLAN_STORAGE_LIMITS: Record<string, number> = {
  basic: 5  * 1024 * 1024 * 1024,  // 5 GB
  plus:  25 * 1024 * 1024 * 1024,  // 25 GB
};

export const PLAN_WORKSPACE_LIMITS: Record<string, number> = {
  basic: 2,
  plus:  Infinity,
};

function normalizePlan(plan: string): string {
  const p = plan.toLowerCase();
  if (p.includes('plus') || p.includes('pro') || p.includes('premium')) return 'plus';
  return 'basic';
}

export function getStorageLimit(plan: string): number {
  return PLAN_STORAGE_LIMITS[normalizePlan(plan)] ?? PLAN_STORAGE_LIMITS.basic;
}

export function getWorkspaceLimit(plan: string): number {
  return PLAN_WORKSPACE_LIMITS[normalizePlan(plan)] ?? PLAN_WORKSPACE_LIMITS.basic;
}

/**
 * Sums the stored asset sizes across all projects for a tenant.
 * Uses the size column in each project's assets table (updated on upload and overwrite).
 */
export function getTenantUsedBytes(dd: string): number {
  const projects = listProjects(dd);
  let total = 0;
  for (const project of projects) {
    try {
      const db = getProjectDb(project.id, dd);
      const row = db.prepare<[], { total: number }>(
        'SELECT COALESCE(SUM(size), 0) AS total FROM assets'
      ).get();
      if (row) total += row.total;
    } catch { /* DB may not exist yet for brand-new projects */ }
  }
  return total;
}
