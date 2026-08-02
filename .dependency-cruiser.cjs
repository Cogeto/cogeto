/**
 * Module-boundary rules (AGENTS.md "Modules", spec §15),
 * enforced in CI via `npm run boundaries`.
 *
 * The contract these rules implement is written down in
 * `docs/module-boundary-contract.md`: a boundary is imports PLUS table
 * ownership PLUS job-type contracts PLUS dependency-injection visibility
 * (spec §15.1). This file covers the import dimension and the import-visible
 * half of table ownership; the other three dimensions, and the completeness of
 * MODULES below, are checked by `project/src/entrypoints/boundary-contract.spec.ts`.
 */

/**
 * Every bounded context under project/src, by role. Adding a directory there
 * without adding it here would leave it SILENTLY UNCHECKED rather than clean
 * (which is how `passport` went unchecked until V2.0 item 3.6). The
 * boundary-contract spec fails the build if this list and the directory
 * listing disagree, so the omission cannot repeat.
 */
const DOMAIN_MODULES = 'memory|ingestion|retrieval|agents|connectors|passport';
const SEAMS = 'identity|model-gateway';
const SHARED = 'infrastructure';
const NON_CONTEXT = 'entrypoints|testing|migrations';
const EVERY_MODULE = [DOMAIN_MODULES, SEAMS, SHARED, NON_CONTEXT].join('|');

/**
 * RECORDED EXCEPTIONS to table ownership (docs/module-boundary-contract.md).
 *
 * Each entry is one file that names a table another module owns. It is listed
 * BY PATH, with the part of V2.0 item 3.6 that removes it, so the debt is
 * enumerable and reviewable instead of laundered through a barrel. The only
 * exemption granted by category is the one argued for in the contract's §5.
 */
const TABLE_OWNERSHIP_EXCEPTIONS = [
  // B8, part 2: the instance-wide audit endpoint's ILIKE filter builder.
  '^project/src/entrypoints/audit\\.controller\\.ts$',
  // B9, part 2: the queue-administration surface (job_execution, dead_letter).
  '^project/src/entrypoints/jobs\\.controller\\.ts$',
  // B10, part 2: the attention read-state pair.
  '^project/src/entrypoints/attention\\.service\\.ts$',
  // B17, part 2: a connectors spec resetting infrastructure's user-context
  // tables between cases (the service exposes no reset, correctly).
  '^project/src/connectors/context-suggestions\\.spec\\.ts$',
].join('|');

module.exports = {
  forbidden: [
    {
      name: 'every-module-is-in-the-module-map',
      comment:
        'A directory under project/src that the four lists above do not name is UNCHECKED by ' +
        'every rule below, not clean: that is how `passport` escaped the seam and ' +
        'infrastructure rules for its whole life. Any import into an unnamed directory fails ' +
        'here, and the boundary-contract spec fails on the directory even before anything ' +
        'imports it.',
      severity: 'error',
      from: { path: '^project/src/' },
      to: {
        path: `^project/src/(?!(${EVERY_MODULE})/)[^/]+/`,
        // `project/src/node_modules/` is an npm placement artifact, not a
        // bounded context (dependency-cruiser >=17 resolves into it).
        pathNot: '^project/src/node_modules/',
      },
    },
    {
      name: 'no-module-internal-imports',
      comment:
        'A bounded context may import another context only through its public interface ' +
        '(the index.ts barrel). Internals are private (spec §15 rule 1).',
      severity: 'error',
      from: { path: '^project/src/([^/]+)/' },
      to: {
        path: '^project/src/(?!$1/)[^/]+/.+',
        // The barrel is the one allowed entry point; nested node_modules are
        // npm placement artifacts (a workspace-local dependency dir is not a
        // bounded context — dependency-cruiser >=17 resolves into them).
        // `persistence/tables.ts` is delegated to no-cross-module-persistence-imports
        // below, which forbids it with a NAMED, enumerated exception list; if it
        // were also forbidden here the exceptions would have to be exempted from
        // the whole internals rule, which would let them import anything.
        pathNot: '^project/src/([^/]+/(index|persistence/tables)\\.ts$|node_modules/)',
      },
    },
    {
      name: 'seams-import-no-domain-module',
      comment:
        'identity and model-gateway are leaf seams: they import no domain module (spec §12.1).',
      severity: 'error',
      from: { path: `^project/src/(${SEAMS})/` },
      to: { path: `^project/src/(${DOMAIN_MODULES})/` },
    },
    {
      name: 'nothing-imports-entrypoints',
      comment: 'Entrypoints are composition roots; no module depends on an entrypoint (spec §15).',
      severity: 'error',
      from: { path: '^project/src/', pathNot: '^project/src/entrypoints/' },
      to: { path: '^project/src/entrypoints/' },
    },
    {
      name: 'no-cross-module-persistence-imports',
      comment:
        "No module reads another module's tables (spec §15 rule 2, §15.2). Drizzle table " +
        'definitions live under <module>/persistence/ and are module-private. The named ' +
        'exceptions are the ones listed in docs/module-boundary-contract.md, each with the ' +
        'V2.0 item 3.6 part that removes it.',
      severity: 'error',
      from: { path: '^project/src/([^/]+)/', pathNot: TABLE_OWNERSHIP_EXCEPTIONS },
      to: { path: '^project/src/(?!$1/)[^/]+/persistence/' },
    },
    {
      name: 'no-live-tables-in-a-barrel',
      comment:
        'Spec §15.2: barrels MUST NOT re-export live tables. A barrel that exports a table ' +
        'object turns every cross-module table read into a legal-looking barrel import that ' +
        'the persistence rule cannot see — which is exactly how infrastructure/index.ts ' +
        'laundered ten of them. Type-only exports (MemoryRow, SourceType) are fine: a row ' +
        'shape is a contract, a table object is a handle to the data.',
      severity: 'error',
      from: { path: '^project/src/[^/]+/index\\.ts$' },
      to: {
        path: '^project/src/[^/]+/persistence/tables\\.ts$',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      name: 'infrastructure-imports-no-module',
      comment:
        'Shared infrastructure (outbox, queue, audit, db) is a leaf like the seams: ' +
        'it imports no domain module and no seam.',
      severity: 'error',
      from: { path: `^project/src/${SHARED}/` },
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
        'All model calls go through the gateway seam (spec §12.1); only it may import the client.',
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
        '; no other module may import it.',
      severity: 'error',
      from: { path: '^project/', pathNot: '^project/src/memory/' },
      to: { path: 'node_modules/@qdrant' },
    },
    {
      name: 'only-composition-roots-import-pg',
      comment:
        'Raw pg (Pool/Client) is confined to the composition roots + the database module ' +
        ': entrypoints/** and infrastructure/{db,database.module,migrations}.ts. A ' +
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

// The four constants at the top are the module inventory these rules are
// written against. `project/src/entrypoints/boundary-contract.spec.ts` reads
// them out of this file's source and fails the build if they and the directory
// listing under project/src disagree, so a new bounded context cannot be
// silently unchecked the way `passport` was. (dependency-cruiser validates its
// configuration against a closed schema, so the inventory cannot also be
// exported as an extra key.)
