// Build TipTap WYSIWYG editor bundle for Notas
// Run: node scripts/build-editor.js
const { build } = require('esbuild');
const path = require('path');

build({
  entryPoints: [path.join(__dirname, 'tiptap-entry.js')],
  bundle: true,
  format: 'iife',
  globalName: 'TipTapBundle',
  outfile: path.join(__dirname, '../public/js/tiptap.bundle.js'),
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
