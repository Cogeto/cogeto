import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// The canonical Cogeto version (the one the git tag matches) lives in the repo
// root package.json — inject it at build time so the SPA can show it.
const version = (
  JSON.parse(readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    // Bundle @cogeto/shared from its TypeScript source: the package compiles
    // to CommonJS for the Node server, whose re-exports rollup cannot
    // statically resolve for value imports (S3-B: the SPA now imports enums).
    alias: {
      '@cogeto/shared': path.resolve(__dirname, '..', 'shared', 'src', 'index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
