import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The module boundary contract, machine-enforced (V2.0 item 3.6, spec §15.1).
 *
 * `docs/module-boundary-contract.md` is the specification; this file is what
 * makes it more than a document. Spec §15.1: "a boundary is imports plus table
 * ownership plus job type contracts plus dependency injection tokens. Import
 * checking alone is not boundary enforcement." `npm run boundaries` covers the
 * import dimension; the other three are here, plus the check that the
 * dependency rules name every module directory (`passport` did not appear in
 * them at all, so it was unchecked rather than clean).
 *
 * The maps below are the contract in executable form. They are inline and named
 * on purpose: adding a table, a job type, a token, a global module or an
 * exception is a visible edit to a file whose comments say what each entry
 * costs and which part of item 3.6 removes it.
 *
 * Pure file reads; no container needed.
 */

// Resolved from this file, not from cwd: the whole spec is a filesystem sweep,
// so it must scan the same tree however vitest was invoked.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(SRC, '../..');

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * Every table, and the single module that owns it. The owner is the only module
 * that may name it — in Drizzle or in SQL. `infrastructure` owns the ten tables
 * every context appends to and none of them owns (the audit trail, the outbox,
 * the queue ledgers, the attention read-state pair, the per-user context and
 * the two abuse counters), plus the migration ledger it creates and runs.
 */
const TABLE_OWNERS: Readonly<Record<string, string>> = {
  memory: 'memory',
  memory_relation: 'memory',
  file_metadata: 'memory',
  deletion_receipt: 'memory',
  integrity_alert: 'memory',

  verification_result: 'ingestion',
  suppressed_fact_log: 'ingestion',
  dream_run: 'ingestion',
  dream_action: 'ingestion',
  dormant_flag: 'ingestion',

  chat_message: 'retrieval',
  conversation: 'retrieval',

  approval: 'agents',

  note: 'connectors',
  user_settings: 'connectors',
  email_message: 'connectors',
  email_attachment: 'connectors',
  email_allowlist: 'connectors',
  email_refusal: 'connectors',
  web_page: 'connectors',
  research_run: 'connectors',
  skill_run: 'connectors',
  skill_run_step: 'connectors',

  app_user: 'identity',
  prompt_registry: 'model-gateway',
  passport_export: 'passport',

  audit_log: 'infrastructure',
  outbox_event: 'infrastructure',
  job_execution: 'infrastructure',
  dead_letter: 'infrastructure',
  attention_state: 'infrastructure',
  attention_dismissal: 'infrastructure',
  user_context: 'infrastructure',
  context_suggestion_dismissal: 'infrastructure',
  usage_counter: 'infrastructure',
  rate_limit_window: 'infrastructure',
};

/**
 * Tables with no Drizzle declaration. `cogeto_migrations` is written by the
 * migration runner itself (it has to exist before any schema does), and the
 * `graphile_worker` schema is created by the queue library. Both belong to
 * infrastructure as the module that creates and runs them.
 */
const UNDECLARED_INFRASTRUCTURE_TABLES = ['cogeto_migrations'];

/**
 * Every job type, and the module that owns its payload contract and its handler
 * body. The worker composition root is the only place a type is bound to a
 * handler, and it imports every constant rather than spelling one.
 */
const JOB_TYPE_OWNERS: Readonly<Record<string, string>> = {
  'ingestion.pipeline': 'ingestion',
  'file.discard_cleanup': 'ingestion',
  dreaming_cycle: 'ingestion',
  'memory.embed': 'memory',
  'deletion.execute': 'memory',
  deletion_sweep: 'memory',
  'approval.execute': 'agents',
  approval_expiry: 'agents',
  'research.conclude': 'connectors',
  'skill.advance': 'connectors',
  email_refusal_retention: 'connectors',
  'conversation.title': 'retrieval',
  passport_export: 'passport',
  passport_retention: 'passport',
  // Dev-only, profile-gated, defined and registered in the demo entrypoint.
  demo_reset: 'entrypoints',
};

/** `echo` is the outbox round-trip demo (spec §15.4); it belongs to no module. */
const UNOWNED_WORKER_TASKS = ['echo'];

/** Every injection token, and the module that declares and owns it. */
const TOKEN_OWNERS: Readonly<Record<string, string>> = {
  DRIZZLE: 'infrastructure',
  PG_POOL: 'infrastructure',
  RATE_LIMIT_OPTIONS: 'infrastructure',
  INGEST_QUOTA: 'infrastructure',
  RESEARCH_QUOTA: 'infrastructure',
  SSE_LIMITS: 'infrastructure',
  MODEL_USAGE_METER: 'infrastructure',
  PARSE_CAPS: 'infrastructure',
  INSTANCE_TIMEZONE: 'infrastructure',

  PRINCIPAL: 'identity',
  IDENTITY_OPTIONS: 'identity',

  // Ports: memory defines them, the implementing module is bound at the root.
  SOURCE_DELETIONS: 'memory',
  DERIVED_CASCADES: 'memory',
  INGESTION_GUARD: 'memory',
  INSTANCE_KEY_DIR: 'memory',
  SWEEP_OPTIONS: 'memory',

  SOURCE_READERS: 'ingestion',

  CHAT_REPLY_RESOLVER: 'retrieval',
  CHAT_RESEARCH_RESOLVER: 'retrieval',
  CHAT_SKILL_RESOLVER: 'retrieval',
  CONVERSATION_APPEND: 'retrieval',

  FILE_UPLOAD_OPTIONS: 'connectors',
  MAIL_OPTIONS: 'connectors',
  RESEARCH_OPTIONS: 'connectors',

  PASSPORT_OPTIONS: 'passport',

  COGETO_CONFIG: 'entrypoints',
  CAPABILITY_JOB_SOURCES: 'entrypoints',
};

/**
 * The Nest modules allowed to be global, and why (boundary contract §4: a
 * module may be global only if it is registered once per composition root with
 * process-wide configuration AND is infrastructure or a seam, never a domain
 * module). Everything not listed here must be imported explicitly.
 */
const ALLOWED_GLOBAL_MODULES: Readonly<Record<string, string>> = {
  // Defensible under the policy.
  DatabaseModule: 'one Pool and one Drizzle handle per process',
  LimitsModule: 'dynamic config; RateLimitGuard is applied inside domain modules',
  IdentityModule: 'seam; BearerAuthGuard is APP_GUARD, AdminGuard crosses modules',
  ModelGatewayModule: 'seam; dynamic provider config, one gateway per process',

  // RECORDED EXCEPTIONS (docs/module-boundary-contract.md). Each is a domain
  // module and therefore fails the policy; each names the part that removes it.
  MemoryModule: 'EXCEPTION B13, part 2: dynamic storage config, five injectors',
  ConnectorsModule: 'EXCEPTION B14, part 3: source ports reach ingestion/memory by globality',
  EmailReplyModule: 'EXCEPTION B15, part 4: binds CHAT_REPLY_RESOLVER for ChatService',
  ResearchChatModule: 'EXCEPTION B15, part 4: binds CHAT_RESEARCH_RESOLVER for ChatService',
  SkillsModule: 'EXCEPTION B15, part 4: binds CHAT_SKILL_RESOLVER for ChatService',
};

/**
 * RECORDED EXCEPTIONS to raw-SQL table ownership: production files that name a
 * table another module owns, each with the part of item 3.6 that removes it.
 *
 * `*.spec.ts` is excluded from this check as a category, stated here rather
 * than hidden: an integration test's job is to assert against the database, and
 * spec §11.1 REQUIRES the deletion cascade to be verified across five modules'
 * tables at once. Tests remain bound by the import rule — a spec may not import
 * another module's Drizzle table objects (dependency-cruiser enforces that,
 * with its own named exception list), because an import is compile-time
 * coupling rather than an assertion.
 */
const RAW_SQL_EXCEPTIONS: Readonly<Record<string, string>> = {
  // B9, part 2: the queue-administration surface.
  'entrypoints/jobs.controller.ts': 'job_execution, dead_letter, graphile_worker',
  // B11, part 2: the capability snapshot's install date.
  'entrypoints/capabilities.ts': 'cogeto_migrations',
  // B18, part 2: the aggregate health report reads three infrastructure sources.
  'entrypoints/health.controller.ts': 'cogeto_migrations, dead_letter, graphile_worker',
  // B12, part 2: a one-shot CLI for a table dropped in migration 0035; deleted,
  // not moved, once no instance predates 2.0.
  'entrypoints/erase-task-conclusions.ts': 'task_conclusion, memory',
  // B19, part 2: dev/eval/demo tooling that predates the contract and is
  // excluded from the production image (item 3.7 finishes that eviction).
  'entrypoints/vector-smoke.ts': 'memory',
  'entrypoints/eval-chat.ts': 'the chat eval harness seeds six modules directly',
  'entrypoints/demo/ops.ts': 'the demo reset truncates every domain table',
  'entrypoints/demo/seed.ts': 'note',
  'entrypoints/demo/assertions.ts': 'the demo world assertions read four modules',
  // B20, part 3: connectors schedules the discard-cleanup backstop with a raw
  // graphile_worker.add_job because the outbox helper has no delayed enqueue.
  'connectors/files.service.ts': 'graphile_worker',
  // B21: the Testcontainers harness resets the queue between suites. `testing/`
  // is the harness, not a bounded context; it is listed rather than exempted.
  'testing/pg.ts': 'graphile_worker',
};

// ---------------------------------------------------------------------------
// Source scanning
// ---------------------------------------------------------------------------

const walk = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist') continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
};

/** This file states the contract, so it is not itself under it: it names every
 * table, job type and token by construction. */
const SELF = 'entrypoints/boundary-contract.spec.ts';

const SOURCES = walk(SRC)
  .map((file) => ({
    rel: path.relative(SRC, file).replaceAll(path.sep, '/'),
    module: path.relative(SRC, file).replaceAll(path.sep, '/').split('/')[0]!,
    text: readFileSync(file, 'utf8'),
  }))
  .filter((source) => source.rel !== SELF);

/**
 * The string and template-literal CONTENTS of a TypeScript source, comments
 * excluded. A hand-rolled scanner rather than a regex because `'https://x'`
 * contains a line-comment opener and a comment can contain a quote — both of
 * which a regex sweep gets wrong in exactly the direction that hides a
 * violation or invents one.
 */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') {
      while (i < source.length && source[i] !== '\n') i++;
    } else if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
    } else if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const start = ++i;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        i++;
      }
      out.push(source.slice(start, i));
      i++;
    } else i++;
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('boundary_contract', () => {
  it('the dependency rules name every module directory (no context silently unchecked)', () => {
    const config = readFileSync(path.join(REPO, '.dependency-cruiser.cjs'), 'utf8');
    const listed = new Set<string>();
    for (const name of ['DOMAIN_MODULES', 'SEAMS', 'SHARED', 'NON_CONTEXT']) {
      const match = config.match(new RegExp(`const ${name} = '([^']+)'`));
      expect(match, `${name} is missing from .dependency-cruiser.cjs`).toBeTruthy();
      for (const part of match![1]!.split('|')) listed.add(part);
    }
    const directories = readdirSync(SRC)
      .filter((name) => name !== 'node_modules' && name !== 'dist')
      .filter((name) => statSync(path.join(SRC, name)).isDirectory());

    // A directory absent from the rule set is UNCHECKED, not clean: that is how
    // `passport` escaped `seams-import-no-domain-module` for its whole life.
    expect([...directories].sort()).toEqual([...listed].sort());
  });

  it('every Drizzle table is declared once, by the module the contract says owns it', () => {
    const declared = new Map<string, string[]>();
    for (const { rel, module, text } of SOURCES) {
      if (!rel.includes('/persistence/')) continue;
      for (const match of text.matchAll(/pgTable\(\s*'([^']+)'/g)) {
        declared.set(match[1]!, [...(declared.get(match[1]!) ?? []), module]);
      }
    }
    for (const [table, owners] of declared) {
      expect(owners, `${table} is declared in more than one module`).toHaveLength(1);
    }
    const actual = Object.fromEntries([...declared].map(([t, o]) => [t, o[0]!]));
    expect(actual).toEqual(TABLE_OWNERS);
  });

  it('every table a migration creates has an owner (none arrives unowned)', () => {
    const migrations = path.join(SRC, 'migrations');
    const live = new Set<string>();
    for (const name of readdirSync(migrations)
      .filter((f) => f.endsWith('.sql'))
      .sort()) {
      const sql = readFileSync(path.join(migrations, name), 'utf8');
      for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?"?([a-z_]+)"?/gi)) {
        live.add(m[1]!);
      }
      for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?"?([a-z_]+)"?/gi)) {
        live.delete(m[1]!);
      }
    }
    const owned = new Set([...Object.keys(TABLE_OWNERS), ...UNDECLARED_INFRASTRUCTURE_TABLES]);
    expect([...live].filter((t) => !owned.has(t)).sort()).toEqual([]);
    // …and nothing claims ownership of a table no migration creates.
    expect([...Object.keys(TABLE_OWNERS)].filter((t) => !live.has(t)).sort()).toEqual([]);
  });

  it('no production file names a table another module owns in raw SQL', () => {
    const tables = [...Object.keys(TABLE_OWNERS), ...UNDECLARED_INFRASTRUCTURE_TABLES];
    // Only scan literals that are actually SQL. The keywords are matched
    // case-sensitively because every SQL string in this codebase writes them in
    // caps, and lowering that would start matching English prose.
    const looksLikeSql =
      /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|CREATE\s+TABLE|TRUNCATE|ALTER\s+TABLE)\b/;
    const offenders: string[] = [];

    for (const { rel, module, text } of SOURCES) {
      if (rel.endsWith('.spec.ts')) continue; // see RAW_SQL_EXCEPTIONS
      if (rel in RAW_SQL_EXCEPTIONS) continue;
      for (const literal of stringLiterals(text)) {
        if (!looksLikeSql.test(literal)) continue;
        if (/graphile_worker\./.test(literal) && module !== 'infrastructure') {
          offenders.push(`${rel} → graphile_worker (infrastructure)`);
        }
        for (const table of tables) {
          const owner = TABLE_OWNERS[table] ?? 'infrastructure';
          if (owner === module) continue;
          const reference = new RegExp(
            `\\b(?:from|join|into|update|table|only)\\s+(?:public\\.)?"?${table}"?\\b`,
            'i',
          );
          if (reference.test(literal)) offenders.push(`${rel} → ${table} (${owner})`);
        }
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it('every recorded raw-SQL exception still exists (a stale allowlist hides a rule)', () => {
    const files = new Set(SOURCES.map((s) => s.rel));
    expect(Object.keys(RAW_SQL_EXCEPTIONS).filter((rel) => !files.has(rel))).toEqual([]);
  });

  it('every job type is declared once, by the module the contract says owns it', () => {
    const declared = new Map<string, string[]>();
    for (const { module, text } of SOURCES) {
      for (const match of text.matchAll(/export const [A-Z0-9_]*JOB_TYPE = '([^']+)'/g)) {
        declared.set(match[1]!, [...(declared.get(match[1]!) ?? []), module]);
      }
    }
    for (const [jobType, owners] of declared) {
      expect(owners, `${jobType} is declared in more than one module`).toHaveLength(1);
    }
    const actual = Object.fromEntries([...declared].map(([j, o]) => [j, o[0]!]));
    expect(actual).toEqual(JOB_TYPE_OWNERS);
  });

  it('a job-type string appears only inside its owning module (elsewhere: the constant)', () => {
    const offenders: string[] = [];
    for (const { rel, module, text } of SOURCES) {
      for (const literal of stringLiterals(text)) {
        const owner = JOB_TYPE_OWNERS[literal];
        // A literal that IS a job type but is used as something else (an
        // entity type, a table name) still points at the same contract, so the
        // rule is deliberately the strict one: the string belongs to the owner.
        if (owner !== undefined && owner !== module) offenders.push(`${rel} → '${literal}'`);
      }
    }
    expect([...new Set(offenders)].sort()).toEqual([]);
  });

  it('the worker registers exactly the declared job types, nothing more', () => {
    const registry = SOURCES.find((s) => s.rel === 'entrypoints/worker-tasks.ts')!.text;
    const worker = SOURCES.find((s) => s.rel === 'entrypoints/worker.ts')!.text;

    // The task list keys are `[X_JOB_TYPE]:` entries; `echo` is the one literal.
    const constants = new Map<string, string>();
    for (const { text } of SOURCES) {
      for (const m of text.matchAll(/export const ([A-Z0-9_]*JOB_TYPE) = '([^']+)'/g)) {
        constants.set(m[1]!, m[2]!);
      }
    }
    const registered = new Set<string>();
    for (const m of `${registry}\n${worker}`.matchAll(
      /(?:\[([A-Z0-9_]*JOB_TYPE)\]|^\s{4}(echo)):/gm,
    )) {
      const name = m[1] ?? m[2]!;
      registered.add(constants.get(name) ?? name);
    }
    // `taskList[DEMO_RESET_JOB_TYPE] = …` is the profile-gated demo assignment.
    for (const m of worker.matchAll(/taskList\[([A-Z0-9_]*JOB_TYPE)\]\s*=/g)) {
      registered.add(constants.get(m[1]!) ?? m[1]!);
    }

    const expected = [...Object.keys(JOB_TYPE_OWNERS), ...UNOWNED_WORKER_TASKS].sort();
    expect([...registered].sort()).toEqual(expected);
  });

  it('every injection token is declared once, by the module the contract says owns it', () => {
    const declared = new Map<string, string[]>();
    for (const { module, text } of SOURCES) {
      for (const match of text.matchAll(/export const ([A-Z0-9_]+) = Symbol\('([^']+)'\)/g)) {
        // The description must match the constant: a token whose Symbol says
        // something else is unsearchable in a Nest resolution error.
        expect(match[2], `token ${match[1]} has a mismatched Symbol description`).toBe(match[1]);
        declared.set(match[1]!, [...(declared.get(match[1]!) ?? []), module]);
      }
    }
    for (const [token, owners] of declared) {
      expect(owners, `${token} is declared in more than one module`).toHaveLength(1);
    }
    const actual = Object.fromEntries([...declared].map(([t, o]) => [t, o[0]!]));
    expect(actual).toEqual(TOKEN_OWNERS);
  });

  it('only the modules the policy allows are global', () => {
    const globals = new Set<string>();
    for (const { text } of SOURCES) {
      // The decorator form: `@Global()` applies to the next class declared.
      for (const match of text.matchAll(/@Global\(\)/g)) {
        const after = text.slice(match.index!).match(/export class (\w+)/);
        if (after) globals.add(after[1]!);
      }
      // The dynamic form: `global: true` inside the object a `static register`
      // returns, whose `module:` key names the module it belongs to.
      for (const match of text.matchAll(/\bglobal:\s*true\b/g)) {
        const before = text
          .slice(0, match.index!)
          .match(/module:\s*(\w+),(?![\s\S]*module:\s*\w+,)/);
        if (before) globals.add(before[1]!);
      }
    }
    // A global module resolves into every injector regardless of what any
    // module declares it imports: the boundary hole is as large as the module.
    expect([...globals].sort()).toEqual(Object.keys(ALLOWED_GLOBAL_MODULES).sort());
  });
});
