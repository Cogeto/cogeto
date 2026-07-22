import { z } from 'zod';
import { buildLimits } from './limits';
import type { LimitsConfig } from '../infrastructure/index';
import { resolveModelProviders } from '../model-gateway/index';
import type { ResolvedModelProviders } from '../model-gateway/index';
import { assertProductionSecrets } from './secret-preflight';

/**
 * Typed process configuration (research: project-structure-lessons §4).
 * COGETO_-prefixed env vars, validated once at boot — a misconfigured instance
 * fails to start, not on request. Only entrypoints read the environment;
 * modules receive options through their registration APIs.
 */
/** Env-var boolean: only 1/true/on/yes (case-insensitive) are true; anything
 * else, including '0'/'false'/'' and unset, is false. `z.coerce.boolean` cannot
 * be used — it makes the non-empty string '0' true. */
const envBool = z
  .string()
  .optional()
  .transform((v) => ['1', 'true', 'on', 'yes'].includes((v ?? '').trim().toLowerCase()));

const configSchema = z
  .object({
    httpPort: z.coerce.number().int().positive().prefault(3000),
    databaseUrl: z.string().min(1),
    qdrantUrl: z.url(),
    /** Qdrant API key (QS-4) — required for auth on a reachable deployment; the
     * default compose stack keeps Qdrant on the internal network with no key. */
    qdrantApiKey: z.string().min(1).optional(),
    s3Url: z.url(),
    /**
     * Browser-reachable object-storage origin for presigned download URLs (O1,
     * §A.9). Defaults to s3Url; set COGETO_S3_PUBLIC_URL when MinIO's internal
     * hostname is not reachable from the browser (see the O1 owner checklist).
     */
    s3PublicUrl: z.url().optional(),
    /** Object-storage credentials + bucket (decision 0008). Defaults match the
     * compose dev stack; provisioning injects real values per instance. */
    s3AccessKey: z.string().min(1).default('cogeto'),
    s3SecretKey: z.string().min(1).default('cogeto-dev-password'),
    s3Bucket: z.string().min(1).default('cogeto'),
    /** Instance signing keypair directory (§B.1, decision 0008). The local
     * default is gitignored; compose mounts the instance-keys volume. */
    instanceKeyDir: z.string().min(1).default('.instance-keys'),
    /** File-upload cap (O1) — default 25 MB; PDFs/DOCX only. */
    uploadMaxBytes: z.coerce
      .number()
      .int()
      .positive()
      .prefault(25 * 1024 * 1024),
    /** Presigned download-URL lifetime in seconds (§A.9 — short-lived). */
    downloadUrlTtlSeconds: z.coerce.number().int().positive().prefault(300),
    /**
     * Inbound email (Session O4, decision 0028). The instance's unique inbound
     * address (ruling 1), the size caps (ruling 6), the optional capture-owner
     * email (ruling 3), and the shared secret the Haraka queue hook presents to
     * the internal intake endpoint (ruling 7). All set at provision time; the
     * intake endpoint is fail-closed when the token is empty.
     */
    mailInboundAddress: z.string().min(1).optional(),
    mailMaxBytes: z.coerce
      .number()
      .int()
      .positive()
      .prefault(25 * 1024 * 1024),
    mailAttachmentsMaxBytes: z.coerce
      .number()
      .int()
      .positive()
      .prefault(25 * 1024 * 1024),
    adminUserEmail: z.string().min(1).optional(),
    mailIntakeToken: z.string().default(''),
    /** Require SPF-authenticated senders for the self-route (SEC-1); default on. */
    mailRequireAuthenticatedSender: z
      .union([z.literal('0'), z.literal('1'), z.boolean()])
      .default('1')
      .transform((v) => v === true || v === '1'),
    /** Per-sender accepted-message cap within the intake window (SEC-2); 0 = off. */
    mailIntakeMaxPerSender: z.coerce.number().int().nonnegative().prefault(60),
    mailIntakeRateWindowSeconds: z.coerce.number().int().positive().prefault(3600),
    /** host:port of the Haraka SMTP listener for the health probe (Session O4);
     * unset → the mail check reports "not configured" and stays green. */
    mailSmtpAddress: z.string().min(1).optional(),
    /**
     * Web research (Priority 5 Part A; decisions 0042/0043). Discovery is the
     * self-hosted SearXNG container (compose profile `research`, internal
     * network only); unset → the discovery client reports "search unavailable"
     * instead of failing requests. The fetch knobs bound the narrow fetcher:
     * hard per-page timeout, response-size cap, and the ranked-result cap the
     * discovery client enforces. `researchRetainHtml` switches on optional
     * raw-HTML retention (decision 0043 — default off: clean text + URL only).
     */
    searxngUrl: z.url().optional(),
    researchResultCap: z.coerce.number().int().positive().prefault(8),
    researchSearchTimeoutSeconds: z.coerce.number().int().positive().prefault(10),
    researchFetchTimeoutSeconds: z.coerce.number().int().positive().prefault(15),
    researchFetchMaxBytes: z.coerce
      .number()
      .int()
      .positive()
      .prefault(5 * 1024 * 1024),
    researchRetainHtml: envBool,
    /**
     * Postgres connection-pool ceiling per process (QS-38). Sized against worker
     * concurrency (2): the ingestion pipeline deliberately holds its idempotency
     * transaction OPEN across model calls (decision 0004/0005 — a retry must
     * leave no partial rows), so each in-flight job pins a connection for its
     * whole run; the single-flight lock (QS-39) and the graphile runner pin more.
     * The default 10 gives ample headroom over concurrency for both the Nest pool
     * and the worker's graphile pool. Raise it only alongside worker concurrency.
     */
    pgPoolMax: z.coerce.number().int().positive().prefault(10),
    oidc: z.object({
      /** Public issuer as the browser sees it, e.g. https://localhost */
      issuer: z.url(),
      /** Zitadel reachable inside the compose network, e.g. http://zitadel:8080 */
      internalUrl: z.url(),
      /** External domain Zitadel resolves its instance by (Host header). */
      externalDomain: z.string().min(1),
    }),
    /** Written by the zitadel-init bootstrap job; served as GET /api/config. */
    webConfigFile: z.string().min(1),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    /**
     * Instance display timezone (QS-32) — relative dates ("today"/"tomorrow")
     * resolve against local midnight in THIS zone, not UTC, fixing the
     * near-midnight off-by-one for the EU audience. IANA name; default matches
     * the primary market. All chain/interval math stays UTC; only the day
     * boundary is zoned.
     */
    timezone: z.string().min(1).default('Europe/Zagreb'),
    /**
     * Zitadel project role that unlocks the operator System view (QS-10): the
     * queue activity/dead-letter reads and retry, which expose cross-user
     * source ids. A member without it gets 403 on /api/jobs/*.
     */
    adminRole: z.string().min(1).default('admin'),
    /**
     * Ana sandbox (decision 0022). `demoMode` turns this instance into the public
     * sandbox: the app serves the pre-minted demo session on GET /api/config and
     * the worker schedules the periodic reset. Never set on a customer instance.
     */
    demoMode: envBool,
    /** Production marker — when true, the demo seed/reset refuse to run
     * (`assertDemoAllowed`). Set by `COGETO_PRODUCTION=1` or `COGETO_ENV=production`. */
    production: envBool,
    /** Shared file the demo-seed job writes the demo Principal's PAT to and the
     * app reads to populate `WebConfig.demoSession` (decision 0022 ruling 1). */
    demoSessionFile: z.string().min(1).default('/demo-config/session.json'),
    /** Cron for the scheduled demo reset (demo profile only) — default every 6h. */
    demoResetCron: z.string().min(1).default('0 */6 * * *'),
    /** App base URL the demo seed/reset drives the public API through. */
    demoAppUrl: z.url().default('http://app:3000'),
    /** Bootstrap machine-user PAT the demo-seed job provisions the demo Principal
     * with (written by zitadel FirstInstance; mounted like zitadel-init). */
    zitadelPatFile: z.string().min(1).default('/machinekey/pat.txt'),
    /**
     * Redaction mode (Addendum B.8; decision 0002 language boundary). `REDACTION_*`
     * (not COGETO_-prefixed) — set by the `redaction` compose profile. When on, the
     * gateway pseudonymizes every outbound model call and fails closed if the
     * sidecar is unreachable. `REDACTION_URL` is required when enabled.
     */
    redactionEnabled: envBool,
    redactionUrl: z.url().optional(),
    /**
     * Fail-closed assertion (QS-21): when set, the process REFUSES to boot
     * unless redaction is actually enabled. The `redaction` compose profile sets
     * this on the app + worker, so bringing the profile up while forgetting
     * `REDACTION_ENABLED=1` fails loudly at boot instead of silently sending
     * plaintext to the model — "profile up, redaction off" can no longer pass.
     */
    redactionRequired: envBool,
  })
  .refine((c) => !c.redactionEnabled || !!c.redactionUrl, {
    path: ['redactionUrl'],
    error: 'REDACTION_URL is required when REDACTION_ENABLED is set',
  })
  .refine((c) => !c.redactionRequired || c.redactionEnabled, {
    path: ['redactionEnabled'],
    error:
      'REDACTION_REQUIRED is set but REDACTION_ENABLED is not — refusing to boot without redaction (QS-21)',
  });

export type CogetoConfig = z.infer<typeof configSchema> & {
  /** Abuse/DoS limits (FIX-2), resolved from env + demoMode at load. */
  limits: LimitsConfig;
  /**
   * Per-tier model provider configuration (decision 0040): provider + model
   * for pipeline/answer/embeddings, the stable configuration id, and the
   * provider keys (never logged or serialized to any DTO). Invalid
   * combinations threw inside loadConfig — boot-time, never first-request.
   */
  modelProviders: ResolvedModelProviders;
};

/**
 * The demo-profile boot guard (decision 0022 ruling 4). Every demo entrypoint
 * (seed, reset) calls this first: a production instance that somehow received
 * the demo profile fails loudly rather than seeding fictional data into real
 * infrastructure, and running a demo tool without `COGETO_DEMO_MODE` is refused.
 * Pure and side-effect-free so `demo_disabled_in_production` can assert it.
 */
export function assertDemoAllowed(config: Pick<CogetoConfig, 'demoMode' | 'production'>): void {
  if (config.production) {
    throw new Error(
      'refusing to run a demo tool on a production instance ' +
        '(COGETO_PRODUCTION / COGETO_ENV=production is set) — decision 0022 ruling 4',
    );
  }
  if (!config.demoMode) {
    throw new Error(
      'refusing to run a demo tool without COGETO_DEMO_MODE=1 — the demo profile ' +
        'is never enabled on a customer instance (decision 0022 ruling 4)',
    );
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CogetoConfig {
  const parsed = configSchema.safeParse({
    httpPort: env.COGETO_HTTP_PORT,
    databaseUrl: env.COGETO_DATABASE_URL,
    qdrantUrl: env.COGETO_QDRANT_URL,
    qdrantApiKey: env.COGETO_QDRANT_API_KEY || undefined,
    s3Url: env.COGETO_S3_URL,
    s3PublicUrl: env.COGETO_S3_PUBLIC_URL || undefined,
    s3AccessKey: env.COGETO_S3_ACCESS_KEY || undefined,
    s3SecretKey: env.COGETO_S3_SECRET_KEY || undefined,
    s3Bucket: env.COGETO_S3_BUCKET || undefined,
    instanceKeyDir: env.COGETO_INSTANCE_KEY_DIR || undefined,
    uploadMaxBytes: env.COGETO_UPLOAD_MAX_BYTES || undefined,
    downloadUrlTtlSeconds: env.COGETO_DOWNLOAD_URL_TTL_SECONDS || undefined,
    mailInboundAddress: env.COGETO_MAIL_INBOUND_ADDRESS || undefined,
    mailMaxBytes: env.COGETO_MAIL_MAX_BYTES || undefined,
    mailAttachmentsMaxBytes: env.COGETO_MAIL_ATTACHMENTS_MAX_BYTES || undefined,
    adminUserEmail: env.COGETO_ADMIN_USER_EMAIL || undefined,
    mailIntakeToken: env.COGETO_MAIL_INTAKE_TOKEN || undefined,
    mailRequireAuthenticatedSender: env.COGETO_MAIL_REQUIRE_SPF || undefined,
    mailIntakeMaxPerSender: env.COGETO_MAIL_INTAKE_MAX_PER_SENDER || undefined,
    mailIntakeRateWindowSeconds: env.COGETO_MAIL_INTAKE_RATE_WINDOW_SECONDS || undefined,
    mailSmtpAddress: env.COGETO_MAIL_SMTP_ADDRESS || undefined,
    searxngUrl: env.COGETO_SEARXNG_URL || undefined,
    researchResultCap: env.COGETO_RESEARCH_RESULT_CAP || undefined,
    researchSearchTimeoutSeconds: env.COGETO_RESEARCH_SEARCH_TIMEOUT_SECONDS || undefined,
    researchFetchTimeoutSeconds: env.COGETO_RESEARCH_FETCH_TIMEOUT_SECONDS || undefined,
    researchFetchMaxBytes: env.COGETO_RESEARCH_FETCH_MAX_BYTES || undefined,
    researchRetainHtml: env.COGETO_RESEARCH_RETAIN_HTML,
    pgPoolMax: env.COGETO_PG_POOL_MAX || undefined,
    oidc: {
      issuer: env.COGETO_OIDC_ISSUER,
      internalUrl: env.COGETO_OIDC_INTERNAL_URL,
      externalDomain: env.COGETO_OIDC_EXTERNAL_DOMAIN,
    },
    webConfigFile: env.COGETO_WEB_CONFIG_FILE,
    logLevel: env.COGETO_LOG_LEVEL,
    timezone: env.COGETO_TIMEZONE || undefined,
    adminRole: env.COGETO_ADMIN_ROLE || undefined,
    demoMode: env.COGETO_DEMO_MODE || undefined,
    // Either explicit flag or the conventional COGETO_ENV=production marker.
    production:
      env.COGETO_PRODUCTION || (env.COGETO_ENV === 'production' ? 'true' : undefined) || undefined,
    demoSessionFile: env.COGETO_DEMO_SESSION_FILE || undefined,
    demoResetCron: env.COGETO_DEMO_RESET_CRON || undefined,
    demoAppUrl: env.COGETO_DEMO_APP_URL || undefined,
    zitadelPatFile: env.COGETO_ZITADEL_PAT_FILE || undefined,
    // Redaction mode (Addendum B.8) — REDACTION_* namespace, set by the profile.
    redactionEnabled: env.REDACTION_ENABLED,
    redactionUrl: env.REDACTION_URL || undefined,
    redactionRequired: env.REDACTION_REQUIRED,
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid COGETO_* configuration:\n${details}`);
  }
  // QS-8: refuse known dev secret values on a non-localhost deployment. Checks
  // whatever secret env vars are present (the app sees a subset; the dedicated
  // preflight container sees them all) — absent vars are skipped.
  assertProductionSecrets(env);
  // Model provider configuration (decision 0040): the same resolver every
  // process uses; an invalid combination refuses boot with the exact variable
  // to fix, never failing at first request.
  const modelProviders = resolveModelProviders(env, { redacted: parsed.data.redactionEnabled });
  return { ...parsed.data, limits: buildLimits(env, parsed.data.demoMode), modelProviders };
}

export const COGETO_CONFIG = Symbol('COGETO_CONFIG');

/**
 * Inbound-email wiring for the connectors module (Session O4, decision 0028),
 * assembled from the validated config so both composition roots pass one shape.
 */
export function mailOptions(config: CogetoConfig): {
  inboundAddress: string | null;
  maxBytes: number;
  attachmentsMaxBytes: number;
  adminUserEmail: string | null;
  intakeToken: string;
  requireAuthenticatedSender: boolean;
  intakeMaxPerSenderPerWindow: number;
  intakeRateWindowSeconds: number;
} {
  return {
    inboundAddress: config.mailInboundAddress ?? null,
    maxBytes: config.mailMaxBytes,
    attachmentsMaxBytes: config.mailAttachmentsMaxBytes,
    adminUserEmail: config.adminUserEmail ?? null,
    intakeToken: config.mailIntakeToken,
    requireAuthenticatedSender: config.mailRequireAuthenticatedSender,
    intakeMaxPerSenderPerWindow: config.mailIntakeMaxPerSender,
    intakeRateWindowSeconds: config.mailIntakeRateWindowSeconds,
  };
}

/**
 * Web-research wiring for the connectors module (Priority 5 Part A, decisions
 * 0042/0043), assembled from the validated config so both composition roots
 * pass one shape.
 */
export function researchOptions(config: CogetoConfig): {
  searxngUrl: string | null;
  resultCap: number;
  searchTimeoutMs: number;
  fetchTimeoutMs: number;
  fetchMaxBytes: number;
  retainHtml: boolean;
} {
  return {
    searxngUrl: config.searxngUrl ?? null,
    resultCap: config.researchResultCap,
    searchTimeoutMs: config.researchSearchTimeoutSeconds * 1000,
    fetchTimeoutMs: config.researchFetchTimeoutSeconds * 1000,
    fetchMaxBytes: config.researchFetchMaxBytes,
    retainHtml: config.researchRetainHtml,
  };
}

/**
 * Redaction wiring for the model-gateway factory (Addendum B.8). Undefined when
 * off, so every construction site passes it uniformly and the decorator wraps all
 * model traffic only on the `redaction` profile.
 */
export function redactionOptions(
  config: Pick<CogetoConfig, 'redactionEnabled' | 'redactionUrl'>,
): { enabled: boolean; url: string } | undefined {
  return config.redactionEnabled && config.redactionUrl
    ? { enabled: true, url: config.redactionUrl }
    : undefined;
}

/**
 * Redaction wiring read straight from the environment, for the lightweight
 * entrypoints (eval, smokes) that do not run the full `loadConfig`. Same
 * `REDACTION_*` namespace and fail-fast rule as the app config.
 */
export function redactionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): { enabled: boolean; url: string } | undefined {
  const enabled = ['1', 'true', 'on', 'yes'].includes((env.REDACTION_ENABLED ?? '').toLowerCase());
  if (!enabled) return undefined;
  if (!env.REDACTION_URL) {
    throw new Error('REDACTION_URL is required when REDACTION_ENABLED is set');
  }
  return { enabled: true, url: env.REDACTION_URL };
}
