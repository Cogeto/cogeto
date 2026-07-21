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
        // The barrel is the one allowed entry point; nested node_modules are
        // npm placement artifacts (a workspace-local dependency dir is not a
        // bounded context — dependency-cruiser >=17 resolves into them).
        pathNot: '^project/src/([^/]+/index\\.ts$|node_modules/)',
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
      name: 'infrastructure-imports-no-module',
      comment:
        'Shared infrastructure (outbox, queue, audit, db) is a leaf like the seams: ' +
        'it imports no domain module and no seam.',
      severity: 'error',
      from: { path: '^project/src/infrastructure/' },
      to: { path: `^project/src/(${DOMAIN_MODULES}|${SEAMS})/` },
    },
    {
      name: 'only-identity-imports-oidc-clients',
      comment: 'No module other than identity may reference Zitadel/OIDC client libraries (§4.5).',
      severity: 'error',
      from: { path: '^project/', pathNot: '^project/src/identity/' },
      to: { path: 'node_modules/(openid-client|oidc-client|@zitadel)' },
    },
    {
      name: 'only-model-gateway-imports-mistral',
      comment:
        'All model calls go through the gateway seam (§A.10); only it may import the client.',
      severity: 'error',
      from: { path: '^project/', pathNot: '^project/src/model-gateway/' },
      to: { path: 'node_modules/@mistralai' },
    },
    {
      name: 'only-model-gateway-imports-provider-sdks',
      comment:
        'Decision 0040: the provider adapters live in the gateway; even if an OpenAI or ' +
        'Anthropic SDK is ever added, no module outside the seam may import it. Complements ' +
        'the grep-level no_provider_leakage test (endpoint hostnames, since the adapters ' +
        'speak plain fetch).',
      severity: 'error',
      from: { path: '^project/', pathNot: '^project/src/model-gateway/' },
      to: { path: 'node_modules/(openai|@anthropic-ai)' },
    },
    {
      name: 'only-memory-imports-qdrant',
      comment:
        'The memory module owns ALL storage access including the Qdrant client ' +
        '(decision 0003 ruling 2); no other module may import it.',
      severity: 'error',
      from: { path: '^project/', pathNot: '^project/src/memory/' },
      to: { path: 'node_modules/@qdrant' },
    },
    {
      name: 'only-composition-roots-import-pg',
      comment:
        'Raw pg (Pool/Client) is confined to the composition roots + the database module ' +
        '(QS-40): entrypoints/** and infrastructure/{db,database.module,migrations}.ts. A ' +
        'domain module opening its own Pool would run raw SQL that the persistence rule ' +
        'cannot see — closing the last "no cross-module table access" gap left to convention.',
      severity: 'error',
      from: {
        path: '^project/src/',
        pathNot:
          '^project/src/entrypoints/|^project/src/infrastructure/(db|database\\.module|migrations)\\.ts$|^project/src/testing/|\\.spec\\.ts$',
      },
      to: { path: 'node_modules/pg/' },
    },
    {
      name: 'testing-helpers-only-in-tests',
      comment: 'The testing harness never leaks into production code.',
      severity: 'error',
      from: { path: '^project/src/', pathNot: '\\.spec\\.ts$|^project/src/testing/' },
      to: { path: '^project/src/testing/' },
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
