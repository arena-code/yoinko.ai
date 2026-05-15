<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into Yoinko.ai. A new singleton (`src/server/posthog.ts`) initializes the `posthog-node` SDK from environment variables and exposes a `getDistinctId` helper that resolves the Supabase user ID in cloud mode and falls back to `'self-hosted'` for self-hosted instances. Shutdown is wired into the existing Express graceful-shutdown handler so all queued events flush before the process exits.

Events are captured across six server-side route files. In `routes/auth.ts`, the JWT access token is decoded on `POST /auth/set-token` to fire an `identify` call and a `user_signed_in` event; both logout routes attempt to extract the user ID from the cookie before clearing it to emit `user_signed_out`. In `routes/pages.ts`, five events cover the full page lifecycle: creation, updates, deletion, sharing, and unsharing. In `routes/assets.ts`, file upload batches and individual deletes are tracked. In `routes/ai.ts`, each AI chat exchange and every successfully generated image are captured with provider context. In `routes/projects.ts`, workspace creation and deletion are tracked. In `routes/settings.ts`, LLM provider profile saves are captured with the provider name and whether it was a new or updated profile. Every route's error handler also calls `posthog.captureException()` for automatic error tracking.

| Event | Description | File |
|---|---|---|
| `user_signed_in` | User authenticated and session token stored | `src/server/routes/auth.ts` |
| `user_signed_out` | User signed out and auth cookies cleared | `src/server/routes/auth.ts` |
| `page_created` | New page or folder created in a workspace | `src/server/routes/pages.ts` |
| `page_updated` | Page content or name updated | `src/server/routes/pages.ts` |
| `page_deleted` | Page or folder deleted from a workspace | `src/server/routes/pages.ts` |
| `page_shared` | Page published as a public share link | `src/server/routes/pages.ts` |
| `page_unshared` | Page's public share removed | `src/server/routes/pages.ts` |
| `asset_uploaded` | One or more files uploaded to a workspace | `src/server/routes/assets.ts` |
| `asset_deleted` | A file asset deleted from a workspace | `src/server/routes/assets.ts` |
| `ai_chat_message_sent` | User sent a message to the AI chat assistant | `src/server/routes/ai.ts` |
| `ai_image_generated` | AI-generated image created and saved | `src/server/routes/ai.ts` |
| `project_created` | New workspace project created | `src/server/routes/projects.ts` |
| `project_deleted` | Workspace project deleted | `src/server/routes/projects.ts` |
| `llm_profile_configured` | LLM provider profile created or updated | `src/server/routes/settings.ts` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on user behavior, based on the events we just instrumented:

- [Analytics basics dashboard](/dashboard/1588594)
- [Daily Sign-ins](/insights/t5XYwxza) — Unique users signing in each day
- [Sign-in to Page Creation Funnel](/insights/rb6ltU8p) — Conversion from signing in to creating a page
- [AI Feature Usage](/insights/lpBovhNV) — Chat messages and images generated via AI
- [Content Activity](/insights/h1nZMakR) — Pages created, updated, and deleted over time
- [Sharing & Uploads](/insights/SxNunlSC) — Pages shared publicly and files uploaded

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
