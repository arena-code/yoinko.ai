import * as Sentry from '@sentry/react';

declare const __YOINKO_RELEASE__: string;
declare const __YOINKO_ENVIRONMENT__: string;

declare global {
  interface Window {
    testGlitchTip: () => string;
    testGlitchTipLog: () => string;
  }
}

type GlitchTipReactOptions = Parameters<typeof Sentry.init>[0] & {
  autoSessionTracking: boolean;
  enableLogs: boolean;
};

const sentrySearchParams = new URLSearchParams(window.location.search);

const glitchTipOptions: GlitchTipReactOptions = {
  dsn: 'https://d3056766e0c3486ea2af6ba940e2e93e@glitchtip-web-production-ee29.up.railway.app/7',
  tracesSampleRate: 0.01,
  autoSessionTracking: false,
  enableLogs: true,
  debug: sentrySearchParams.has('glitchtip-debug'),
  integrations: [
    Sentry.consoleLoggingIntegration({
      levels: ['log', 'info', 'warn', 'error'],
    }),
  ],
  release: __YOINKO_RELEASE__,
  environment: __YOINKO_ENVIRONMENT__,
};

Sentry.init(glitchTipOptions);

function sendGlitchTipTestError(source: 'query-param' | 'console' = 'console'): string {
  const eventId = Sentry.captureException(new Error('Test GlitchTip error'), {
    tags: {
      verification: 'glitchtip',
      source,
    },
    extra: {
      release: __YOINKO_RELEASE__,
      environment: __YOINKO_ENVIRONMENT__,
    },
  });

  void Sentry.flush(2500).then(flushed => {
    const status = flushed ? 'flushed' : 'queued';
    console.info(`[GlitchTip] Test error ${status}. Event ID: ${eventId}`);
  });

  return eventId;
}

function sendGlitchTipTestLog(source: 'query-param' | 'console' = 'console'): string {
  const message = 'Test GlitchTip log';

  Sentry.logger.info(message, {
    environment: __YOINKO_ENVIRONMENT__,
    release: __YOINKO_RELEASE__,
    source,
    verification: 'glitchtip',
  });

  void Sentry.flush(2500).then(flushed => {
    const status = flushed ? 'flushed' : 'queued';
    console.info(`[GlitchTip] Test log ${status}.`);
  });

  return message;
}

window.testGlitchTip = () => sendGlitchTipTestError('console');
window.testGlitchTipLog = () => sendGlitchTipTestLog('console');

if (sentrySearchParams.has('glitchtip-test')) {
  window.setTimeout(() => sendGlitchTipTestError('query-param'), 0);
}

if (sentrySearchParams.has('glitchtip-log-test')) {
  window.setTimeout(() => sendGlitchTipTestLog('query-param'), 0);
}

export { Sentry };
