// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * Product-copy guard (P6.8, Issue B). A local rule — no new dependency — that
 * fails on an em (—) or en (–) dash in USER-FACING copy: string literals, JSX
 * text, and template literals. It inspects only those AST nodes, so code
 * comments (which are exempt, and full of dashes) never trip it. Scoped below to
 * project/web/src product copy; out-of-scope paths (specs, backend log/error
 * strings, seeded note bodies that simulate user input, docs authoring, and
 * user/historical data) are excluded there. See docs/engineering-workflow.md.
 */
const EN_EM_DASH = /[–—]/;
const copyPlugin = {
  rules: {
    'no-typographic-dashes': {
      meta: {
        type: 'problem',
        docs: { description: 'Disallow em/en dashes in user-facing product copy.' },
        messages: {
          dash: 'Em/en dash ({{ch}}) in product copy — rewrite with a comma, colon, period, or a restructured sentence (never a mechanical hyphen).',
        },
      },
      create(context) {
        const report = (node, value) => {
          if (typeof value === 'string' && EN_EM_DASH.test(value)) {
            const ch = value.includes('—') ? 'em dash' : 'en dash';
            context.report({ node, messageId: 'dash', data: { ch } });
          }
        };
        return {
          Literal(node) {
            if (typeof node.value === 'string') report(node, node.value);
          },
          JSXText(node) {
            report(node, node.value);
          },
          TemplateElement(node) {
            report(node, node.value?.raw ?? '');
          },
        };
      },
    },
  },
};

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
    // Product-copy dash guard: only web source copy, never the specs/fixtures.
    files: ['project/web/src/**/*.ts', 'project/web/src/**/*.tsx'],
    ignores: ['**/*.spec.ts', '**/*.spec.tsx', '**/*.test.ts', '**/*.test.tsx'],
    plugins: { copy: copyPlugin },
    rules: { 'copy/no-typographic-dashes': 'error' },
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
