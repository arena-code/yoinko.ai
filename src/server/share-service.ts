import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { getGlobalDb, getProjectDb } from './db.js';
import { CLOUD_DATA_ROOT, CLOUD_ENABLED } from './tenant-context.js';
import { getPagesDir, readPage, scanDir, flattenTree, toId } from './files.js';
import { DATA_DIR, getProjectDirs } from './projects.js';
import type { Asset, PageNode, PageShareInfo } from '../shared/types.js';

export interface PageShareRecord {
  token: string;
  project_id: string;
  page_id: string;
  page_path: string;
  password_hash: string | null;
  password_salt: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssetShareRecord {
  token: string;
  project_id: string;
  asset_id: string;
  password_hash: string | null;
  password_salt: string | null;
  created_at: string;
  updated_at: string;
}

export interface PasswordShareRecord {
  token: string;
  password_hash: string | null;
  password_salt: string | null;
}

export interface ResolvedPageShare {
  dataDir: string;
  share: PageShareRecord;
}

export interface ResolvedAssetShare {
  dataDir: string;
  share: AssetShareRecord;
}

export interface SharedPagePayload {
  page: PageNode;
  content: string;
  assets: Asset[];
}

export interface SharedAssetPayload {
  asset: Asset;
  filePath: string;
}

const SHARE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS page_shares (
    token         TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    page_id       TEXT NOT NULL,
    page_path     TEXT NOT NULL,
    password_hash TEXT,
    password_salt TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE(project_id, page_id)
  );

  CREATE INDEX IF NOT EXISTS idx_page_shares_token ON page_shares(token);

  CREATE TABLE IF NOT EXISTS asset_shares (
    token         TEXT PRIMARY KEY,
    project_id    TEXT NOT NULL,
    asset_id      TEXT NOT NULL,
    password_hash TEXT,
    password_salt TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL,
    UNIQUE(project_id, asset_id)
  );

  CREATE INDEX IF NOT EXISTS idx_asset_shares_token ON asset_shares(token);
`;

export function ensureShareSchema(db: Database.Database): void {
  db.exec(SHARE_SCHEMA_SQL);
}

function now(): string {
  return new Date().toISOString();
}

function randomToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function hashSharePassword(password: string): { hash: string; salt: string } {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(password, salt, 32).toString('base64url');
  return { hash, salt };
}

export function verifySharePassword(password: string, share: PasswordShareRecord): boolean {
  if (!share.password_hash || !share.password_salt) return true;
  const expected = Buffer.from(share.password_hash, 'base64url');
  const actual = crypto.scryptSync(password, share.password_salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function shareInfoFromRecord(
  share: (PasswordShareRecord & { created_at: string; updated_at: string }) | undefined,
  url?: string,
): PageShareInfo {
  if (!share) return { enabled: false };
  return {
    enabled: true,
    token: share.token,
    url,
    password_protected: !!share.password_hash,
    created_at: share.created_at,
    updated_at: share.updated_at,
  };
}

export function getPageShare(db: Database.Database, projectId: string, pageId: string): PageShareRecord | undefined {
  ensureShareSchema(db);
  return db.prepare<[string, string], PageShareRecord>(
    `SELECT * FROM page_shares WHERE project_id = ? AND page_id = ?`
  ).get(projectId, pageId);
}

export function upsertPageShare(
  db: Database.Database,
  projectId: string,
  pageId: string,
  pagePath: string,
  password: { hash: string | null; salt: string | null } | undefined,
): PageShareRecord {
  ensureShareSchema(db);
  const existing = getPageShare(db, projectId, pageId);
  const timestamp = now();

  if (existing) {
    const nextHash = password ? password.hash : existing.password_hash;
    const nextSalt = password ? password.salt : existing.password_salt;
    db.prepare(
      `UPDATE page_shares
       SET page_path = ?, password_hash = ?, password_salt = ?, updated_at = ?
       WHERE token = ?`
    ).run(pagePath, nextHash, nextSalt, timestamp, existing.token);
    return getPageShare(db, projectId, pageId)!;
  }

  const token = randomToken();
  db.prepare(
    `INSERT INTO page_shares
       (token, project_id, page_id, page_path, password_hash, password_salt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(token, projectId, pageId, pagePath, password?.hash ?? null, password?.salt ?? null, timestamp, timestamp);

  return getPageShare(db, projectId, pageId)!;
}

export function deletePageShare(db: Database.Database, projectId: string, pageId: string): void {
  ensureShareSchema(db);
  db.prepare<[string, string]>(
    `DELETE FROM page_shares WHERE project_id = ? AND page_id = ?`
  ).run(projectId, pageId);
}

export function getAssetShare(db: Database.Database, projectId: string, assetId: string): AssetShareRecord | undefined {
  ensureShareSchema(db);
  return db.prepare<[string, string], AssetShareRecord>(
    `SELECT * FROM asset_shares WHERE project_id = ? AND asset_id = ?`
  ).get(projectId, assetId);
}

export function upsertAssetShare(
  db: Database.Database,
  projectId: string,
  assetId: string,
  password: { hash: string | null; salt: string | null } | undefined,
): AssetShareRecord {
  ensureShareSchema(db);
  const existing = getAssetShare(db, projectId, assetId);
  const timestamp = now();

  if (existing) {
    const nextHash = password ? password.hash : existing.password_hash;
    const nextSalt = password ? password.salt : existing.password_salt;
    db.prepare(
      `UPDATE asset_shares
       SET password_hash = ?, password_salt = ?, updated_at = ?
       WHERE token = ?`
    ).run(nextHash, nextSalt, timestamp, existing.token);
    return getAssetShare(db, projectId, assetId)!;
  }

  const token = randomToken();
  db.prepare(
    `INSERT INTO asset_shares
       (token, project_id, asset_id, password_hash, password_salt, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(token, projectId, assetId, password?.hash ?? null, password?.salt ?? null, timestamp, timestamp);

  return getAssetShare(db, projectId, assetId)!;
}

export function deleteAssetShare(db: Database.Database, projectId: string, assetId: string): void {
  ensureShareSchema(db);
  db.prepare<[string, string]>(
    `DELETE FROM asset_shares WHERE project_id = ? AND asset_id = ?`
  ).run(projectId, assetId);
}

export function updatePageShareReference(
  db: Database.Database,
  projectId: string,
  oldPageId: string,
  newPageId: string,
  newPagePath: string,
): void {
  ensureShareSchema(db);
  db.prepare(
    `UPDATE page_shares
     SET page_id = ?, page_path = ?, updated_at = ?
     WHERE project_id = ? AND page_id = ?`
  ).run(newPageId, newPagePath, now(), projectId, oldPageId);
}

export function updatePageSharePathPrefix(
  db: Database.Database,
  projectId: string,
  oldPrefix: string,
  newPrefix: string,
): void {
  ensureShareSchema(db);
  const rows = db.prepare<string, PageShareRecord>(
    `SELECT * FROM page_shares WHERE project_id = ?`
  ).all(projectId);
  const stmt = db.prepare(
    `UPDATE page_shares SET page_id = ?, page_path = ?, updated_at = ? WHERE token = ?`
  );
  const timestamp = now();
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (!row.page_path.startsWith(oldPrefix)) continue;
      const nextPath = newPrefix + row.page_path.slice(oldPrefix.length);
      stmt.run(toId(nextPath), nextPath, timestamp, row.token);
    }
  });
  tx();
}

export function deletePageSharesForIds(db: Database.Database, projectId: string, pageIds: string[]): void {
  ensureShareSchema(db);
  if (!pageIds.length) return;
  const stmt = db.prepare<[string, string]>(
    `DELETE FROM page_shares WHERE project_id = ? AND page_id = ?`
  );
  const tx = db.transaction((ids: string[]) => {
    for (const id of ids) stmt.run(projectId, id);
  });
  tx(pageIds);
}

function candidateShareDataDirs(): string[] {
  if (!CLOUD_ENABLED) return [DATA_DIR];
  if (!fs.existsSync(CLOUD_DATA_ROOT)) return [];
  return fs.readdirSync(CLOUD_DATA_ROOT, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(CLOUD_DATA_ROOT, entry.name))
    .filter(dir => fs.existsSync(path.join(dir, 'global.db')) || fs.existsSync(path.join(dir, 'projects.json')));
}

export function findPageShareByToken(token: string): ResolvedPageShare | undefined {
  for (const candidateDir of candidateShareDataDirs()) {
    const dbPath = path.join(candidateDir, 'global.db');
    if (CLOUD_ENABLED && !fs.existsSync(dbPath)) continue;
    const db = getGlobalDb(candidateDir);
    ensureShareSchema(db);
    const share = db.prepare<string, PageShareRecord>(
      `SELECT * FROM page_shares WHERE token = ?`
    ).get(token);
    if (share) return { dataDir: candidateDir, share };
  }
  return undefined;
}

export function findAssetShareByToken(token: string): ResolvedAssetShare | undefined {
  for (const candidateDir of candidateShareDataDirs()) {
    const dbPath = path.join(candidateDir, 'global.db');
    if (CLOUD_ENABLED && !fs.existsSync(dbPath)) continue;
    const db = getGlobalDb(candidateDir);
    ensureShareSchema(db);
    const share = db.prepare<string, AssetShareRecord>(
      `SELECT * FROM asset_shares WHERE token = ?`
    ).get(token);
    if (share) return { dataDir: candidateDir, share };
  }
  return undefined;
}

export function readSharedPage(resolved: ResolvedPageShare): SharedPagePayload {
  const { dataDir, share } = resolved;
  const pagesDir = getPagesDir(share.project_id, dataDir);
  const flat = flattenTree(scanDir(pagesDir));
  const page = flat.find(p => p.id === share.page_id)
    || flat.find(p => p.path === share.page_path)
    || flat.find(p => toId(p.path) === share.page_id);

  if (!page || page.type !== 'page') {
    throw new Error('Shared page not found');
  }

  const content = readPage(pagesDir, page.path);
  const db = getProjectDb(share.project_id, dataDir);
  const assets = db.prepare<string, Omit<Asset, 'url'>>(
    `SELECT * FROM assets WHERE page_id = ? ORDER BY created_at DESC`
  ).all(page.id);

  return {
    page: { ...page, content, locked: true },
    content,
    assets: assets.map(asset => ({ ...asset, url: `/share/${share.token}/assets/${asset.id}/file` })),
  };
}

export function getSharedAsset(resolved: ResolvedPageShare, assetId: string): { asset: Omit<Asset, 'url'>; filePath: string } | undefined {
  const db = getProjectDb(resolved.share.project_id, resolved.dataDir);
  const asset = db.prepare<[string, string], Omit<Asset, 'url'>>(
    `SELECT * FROM assets WHERE id = ? AND page_id = ?`
  ).get(assetId, resolved.share.page_id);
  if (!asset) return undefined;

  const { uploadsDir } = getProjectDirs(resolved.share.project_id, resolved.dataDir);
  const filePath = path.join(uploadsDir, asset.filename);
  if (!fs.existsSync(filePath)) return undefined;
  return { asset, filePath };
}

export function readSharedAsset(resolved: ResolvedAssetShare): SharedAssetPayload {
  const { dataDir, share } = resolved;
  const db = getProjectDb(share.project_id, dataDir);
  const asset = db.prepare<string, Omit<Asset, 'url'>>(
    `SELECT * FROM assets WHERE id = ?`
  ).get(share.asset_id);

  if (!asset) {
    throw new Error('Shared asset not found');
  }

  const { uploadsDir } = getProjectDirs(share.project_id, dataDir);
  const filePath = path.join(uploadsDir, asset.filename);
  if (!fs.existsSync(filePath)) {
    throw new Error('Shared asset file not found');
  }

  return {
    asset: { ...asset, url: `/share/assets/${share.token}/file` },
    filePath,
  };
}
