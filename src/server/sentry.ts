// src/server/sentry.ts — GlitchTip/Sentry init for the Node server.
// MUST be imported before any other module in src/server/index.ts so that
// @sentry/node's OpenTelemetry instrumentation can patch Express/http at load.
import * as Sentry from '@sentry/node';

const dsn = process.env.GLITCHTIP_DSN ?? process.env.SENTRY_DSN ?? '';
const release = process.env.SENTRY_RELEASE ?? process.env.GLITCHTIP_RELEASE;
const environment = process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development';

if (dsn) {
  Sentry.init({
    dsn,
    release,
    environment,
    tracesSampleRate: 0.01,
    enableLogs: true,
    debug: process.env.GLITCHTIP_DEBUG === 'true',
  });
}

export { Sentry };
