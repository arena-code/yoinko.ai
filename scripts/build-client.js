// Build client-side TypeScript bundle → public/js/app.bundle.js
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

build({
  entryPoints: [join(__dirname, '../src/client/app.ts')],
  bundle: true,
  format: 'iife',
  globalName: 'NotasApp',
  outfile: join(__dirname, '../public/js/app.bundle.js'),
  minify: process.env.NODE_ENV === 'production',
  sourcemap: process.env.NODE_ENV !== 'production',
  target: ['esnext'],
  logLevel: 'info',
}).then(() => {
  console.log('✅ Client bundle built → public/js/app.bundle.js');
}).catch((err) => {
  console.error('❌ Client build failed:', err.message);
  process.exit(1);
});
