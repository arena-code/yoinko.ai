// src/server/posthog.ts — PostHog analytics singleton
import { PostHog } from 'posthog-node';

const apiKey = process.env.POSTHOG_API_KEY ?? '';
const host = process.env.POSTHOG_HOST;

export const posthog = apiKey && host
  ? new PostHog(apiKey, { host, enableExceptionAutocapture: true })
  : null;

/** Extract distinct ID from an Express request.
 *  In cloud mode the Supabase user ID is attached by cloud-auth middleware.
 *  In self-hosted mode there is no user — fall back to 'self-hosted'.
 */
export function getDistinctId(req: any): string {
  return req.user?.id ?? 'self-hosted';
}
