import * as path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
