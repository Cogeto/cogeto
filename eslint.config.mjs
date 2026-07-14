// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/*.d.ts',
      'project/web/dist/**',
      '.dependency-cruiser.cjs',
      // Standalone services with their own runtime + conventions (not the TS
      // workspace): the Python redaction sidecar and the Haraka mail plugins
      // (CommonJS, Haraka's plugin API). Linted/tested within their own service.
      'project/services/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      // NOTE: consistent-type-imports is deliberately absent — NestJS DI relies on
      // emitDecoratorMetadata, which needs injected classes imported as values.
    },
  },
  {
    // Plain-JS infra / demo / dev scripts run under Node; give them the runtime globals.
    files: ['project/infra/**/*.mjs', 'project/demo/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
      },
    },
  },
);
