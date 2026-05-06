# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev           # tsx watch on server + esbuild watch on client + SSE live-reload (port 4568)
npm start             # run the compiled server (dist/server/index.js) — requires npm run build first
npm run build         # full build: server (tsc) + client bundle + tiptap bundle
npm run build:server  # tsc -p tsconfig.server.json → dist/
npm run build:client  # esbuild src/client/app.ts → public/js/app.bundle.js
npm run build:editor  # esbuild scripts/tiptap-entry.js → public/js/tiptap.bundle.js
npm run typecheck     # tsc --noEmit on both server and client tsconfigs
```

Dev server reads `.env` (PORT defaults to 4567 locally; Dockerfile/Railway use 3000). There is no test runner, lint, or formatter configured — `npm run typecheck` is the only static check.

The TipTap bundle and the client bundle must both be rebuilt when their sources change in production. In dev, `watch-client.js` only watches `src/client/app.ts`; if you edit `scripts/tiptap-entry.js` or its TipTap deps, run `npm run build:editor` manually.

## High-Level Architecture

yoınko is a single-process Express app (`src/server/index.ts`) that serves a vanilla-TS SPA from `public/`. There is no framework on the client — `src/client/app.ts` (~2k lines) is bundled to `public/js/app.bundle.js` as an IIFE.

### Filesystem-first content model

Pages are **real files on disk**, not database rows:

- `data/<projectId>/pages/` is the page tree. Folders become folders; `.md` and `.html` files become pages.
- Filename prefix `NN - Name.md` controls sort order (`files.ts:parseName`/`scanDir`).
- Page IDs in the API are `base64url(relativePath)` — see `files.ts:toId`/`fromId`. They change when a page is renamed or moved.
- `files.ts:sanitizePath` is the only path-traversal guard; every route that takes an ID must go through `fromId` → `sanitizePath`.

SQLite is **only** used for sidecar data: `data/<projectId>/yoinko.db` holds `assets` and `chat_messages`; `data/global.db` (or `data/<tenant>/global.db` in cloud mode) holds `settings` (theme, LLM profiles, active profile).

### Multi-project layout

Every API request carries an `X-Project-Id` header (default `"default"`). `request-helpers.ts:projectId(req)` extracts it; routes pass it into `getProjectDb(pid, dataDir)` and `getProjectDirs(pid, dataDir)`. The project registry is `data/projects.json`, managed by `projects.ts`.

`projects.ts:migrateOnStartup` runs on every self-hosted boot and migrates the legacy flat layout (`data/pages/`, `data/uploads/`, `data/notas.db`) into `data/default/`. Don't break this path — users upgrading in place rely on it.

### Self-hosted vs cloud mode

`YOINKO_CLOUD=true` flips the app into multi-tenant mode:

- `middleware/cloud-auth.ts` verifies a Supabase JWT on every request (cookie `yoinko_token`, Supabase SSR cookie, or `Authorization: Bearer`) and looks up the tenant via the Supabase REST API.
- It sets `req.tenantDataDir = /app/data/<subdomain>/`. Routes pull this through `request-helpers.ts:dataDir(req)` and pass it to `getProjectDb`/`getGlobalDb`/`getProjectDirs` so each tenant gets isolated DBs and directories.
- Tenant data dirs are lazily provisioned with seed content on first login (`ensureTenantDir`).
- `auth.ts` serves the `/auth/login` and `/auth/callback` pages (inline HTML using Supabase's browser SDK from a CDN).

Self-hosted mode skips all of that — `cloudAuth` middleware no-ops, `dataDir(req)` returns `undefined`, and helpers fall back to `DEFAULT_DATA_DIR` (`./data`).

**When adding a new route, always thread `dataDir(req)` through to any DB or filesystem helper** — forgetting it silently breaks cloud-mode tenant isolation.

### Unified LLM adapter

`src/server/ai/index.ts` exposes `generateText`, `streamText`, and `generateImage` for four providers (`openai`, `openai-compatible`, `gemini`, `claude`). It pulls the active provider/model/key from the global settings DB; if a `llm_profiles` JSON + `llm_active_profile` are set, those overlay the legacy single-key fields. Streaming chat is exposed at `POST /api/ai/chat` as Server-Sent Events; the client consumes it manually in `api.ts:chatStream` (not `EventSource`, because it needs `POST` + custom headers).

Image responses come back as either a URL (DALL-E) or base64 (Gemini). `routes/ai.ts` always normalises to a saved file in the project's `uploads/` dir + an `assets` row, then returns the asset descriptor.

### Asset serving quirk

`GET /api/assets/:id/file` is hit by `<img>` tags in rendered pages, which **don't send `X-Project-Id`**. The route therefore searches the asserted project first and then falls back to scanning every project's DB (`routes/assets.ts:111`). Keep that fallback when refactoring — removing it breaks images embedded across projects.

### Dev live-reload

`scripts/watch-client.js` runs an SSE server on **port 4568**. The bundled client (`app.ts`) listens on that channel and reloads on `data: reload`. Chokidar watches `public/` for `.css`/`.html` changes; esbuild's `onEnd` callback fires for TS rebuilds. Port 4568 must stay free during `npm run dev`.

## Conventions

- ESM only (`"type": "module"`). Server imports use the `.js` extension on relative paths even though sources are `.ts` (NodeNext resolution).
- Shared types live in `src/shared/types.ts` and are imported by both server and client — keep API response shapes there.
- `routes/*.ts` are thin: parse request → call `files.ts`/`projects.ts`/`db.ts` helpers → return JSON. Don't put business logic in routes.
- API key handling: `routes/settings.ts` masks keys before sending to the client (`maskKey`) and never echoes raw values back. Profile updates without an `api_key` field preserve the existing key — don't change that behaviour without checking the client flow in `app.ts`.
