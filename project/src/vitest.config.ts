import * as path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    env: {
      // The prompt loader's compiled-layout default (dist/) does not resolve
      // when vitest runs from source — point it at project/prompts explicitly.
      COGETO_PROMPTS_DIR: path.resolve(__dirname, '..', 'prompts'),
    },
    // Integration suites each start a real postgres container (Testcontainers).
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
