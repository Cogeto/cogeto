/**
 * Module-boundary rules (AGENTS.md "Modules", Addendum §A.1, decision 0003 ruling 2),
 * enforced in CI via `npm run boundaries`.
 */
const DOMAIN_MODULES = 'memory|ingestion|retrieval|agents|connectors|tasks';
const SEAMS = 'identity|model-gateway';

module.exports = {
  forbidden: [
    {
      name: 'no-module-internal-imports',
      comment:
        'A bounded context may import another context only through its public interface ' +
        '(the index.ts barrel). Internals are private (§A.1 rule 1).',
      severity: 'error',
      from: { path: '^project/src/([^/]+)/' },
      to: {
        path: '^project/src/(?!$1/)[^/]+/.+',
        pathNot: '^project/src/[^/]+/index\\.ts$',
      },
    },
    {
      name: 'seams-import-no-domain-module',
      comment: 'identity and model-gateway are leaf seams: they import no domain module (§A.10).',
      severity: 'error',
      from: { path: `^project/src/(${SEAMS})/` },
      to: { path: `^project/src/(${DOMAIN_MODULES})/` },
    },
    {
      name: 'nothing-imports-entrypoints',
      comment: 'Entrypoints are composition roots; no module depends on an entrypoint (§A.1).',
      severity: 'error',
      from: { path: '^project/src/', pathNot: '^project/src/entrypoints/' },
      to: { path: '^project/src/entrypoints/' },
    },
    {
      name: 'no-cross-module-persistence-imports',
      comment:
        "No module reads another module's tables (§A.1 rule 2). Drizzle table definitions " +
        'live under <module>/persistence/ and are module-private — they may not even be ' +
        'imported via a barrel re-export.',
      severity: 'error',
      from: { path: '^project/src/([^/]+)/' },
      to: { path: '^project/src/(?!$1/)[^/]+/persistence/' },
    },
    {
      name: 'shared-is-a-leaf',
      comment: 'project/shared holds cross-tier DTOs only; it depends on nothing in src or web.',
      severity: 'error',
      from: { path: '^project/shared/' },
      to: { path: '^project/(src|web)/' },
    },
    {
      name: 'web-imports-no-backend',
      comment: 'The SPA talks to the app API over HTTP; it never imports backend code.',
      severity: 'error',
      from: { path: '^project/web/' },
      to: { path: '^project/src/' },
    },
    {
      name: 'no-circular',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.base.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
    exclude: { path: ['\\.d\\.ts$', 'dist/'] },
  },
};
