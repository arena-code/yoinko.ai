// Build client-side TypeScript bundle → public/js/app.bundle.js
import { build } from 'esbuild';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8'));
const release = process.env.SENTRY_RELEASE || process.env.GLITCHTIP_RELEASE || `yoinko@${pkg.version}`;
const environment = process.env.SENTRY_ENVIRONMENT || process.env.GLITCHTIP_ENVIRONMENT || process.env.NODE_ENV || 'development';
const sourcemap = process.env.SOURCEMAP === 'true' || (process.env.NODE_ENV !== 'production' && process.env.SOURCEMAP !== 'false');

build({
  entryPoints: [join(__dirname, '../src/client/app.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'NotasApp',
  outfile: join(__dirname, '../public/js/app.bundle.js'),
  minify: process.env.NODE_ENV === 'production',
  sourcemap,
  target: ['esnext'],
  define: {
    __YOINKO_RELEASE__: JSON.stringify(release),
    __YOINKO_ENVIRONMENT__: JSON.stringify(environment),
  },
  logLevel: 'info',
}).then(() => {
  console.log('✅ Client bundle built → public/js/app.bundle.js');
}).catch((err) => {
  console.error('❌ Client build failed:', err.message);
  process.exit(1);
});
