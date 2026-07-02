import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    // Integration suites each start a real postgres container (Testcontainers).
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
