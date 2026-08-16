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
    // statically resolve for value imports (: the SPA now imports enums).
    alias: {
      '@cogeto/shared': path.resolve(__dirname, '..', 'shared', 'src', 'index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    // No source maps in the shipped artifact (issue #636), the same rule the
    // server build has carried since SEC-32. `npm run build` IS the production
    // build: its output is what the caddy stage bakes into the edge image, so
    // the maps were served from the public origin — about 2.4 MB of them,
    // handing anyone the original TypeScript layout of every page. The code is
    // AGPL and readable in the repository, so this is weight and needless
    // surface rather than a disclosure, but neither belongs on the edge.
    //
    // `vite build --sourcemap` still produces them on demand for a local
    // debugging build, which is the only place they were ever useful.
    sourcemap: false,
  },
});
