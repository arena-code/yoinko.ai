import * as Sentry from '@sentry/react';

declare const __YOINKO_RELEASE__: string;
declare const __YOINKO_ENVIRONMENT__: string;

type GlitchTipReactOptions = Parameters<typeof Sentry.init>[0] & {
  autoSessionTracking: boolean;
};

const glitchTipOptions: GlitchTipReactOptions = {
  dsn: 'https://d3056766e0c3486ea2af6ba940e2e93e@glitchtip-web-production-ee29.up.railway.app/7',
  tracesSampleRate: 0.01,
  autoSessionTracking: false,
  release: __YOINKO_RELEASE__,
  environment: __YOINKO_ENVIRONMENT__,
};

Sentry.init(glitchTipOptions);

export { Sentry };
