// Build TipTap WYSIWYG editor bundle for yoınko
// Run: node scripts/build-editor.js
import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

build({
  entryPoints: [join(__dirname, 'tiptap-entry.js')],
  bundle: true,
  format: 'iife',
  globalName: 'TipTapBundle',
  outfile: join(__dirname, '../public/js/tiptap.bundle.js'),
  minify: process.env.NODE_ENV === 'production',
  sourcemap: false,
  target: ['esnext'],
  // Suppress the "use client" directive warnings from tiptap
  logLevel: 'error',
}).then(() => {
  console.log('✅ TipTap bundle built → public/js/tiptap.bundle.js');
}).catch((err) => {
  console.error('❌ Build failed:', err);
  process.exit(1);
});
