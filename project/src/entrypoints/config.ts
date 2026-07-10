import { z } from 'zod';

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
    httpPort: z.coerce.number().int().positive().default(3000),
    databaseUrl: z.string().min(1),
    qdrantUrl: z.string().url(),
    s3Url: z.string().url(),
    /**
     * Browser-reachable object-storage origin for presigned download URLs (O1,
     * §A.9). Defaults to s3Url; set COGETO_S3_PUBLIC_URL when MinIO's internal
     * hostname is not reachable from the browser (see the O1 owner checklist).
     */
    s3PublicUrl: z.string().url().optional(),
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
      .default(25 * 1024 * 1024),
    /** Presigned download-URL lifetime in seconds (§A.9 — short-lived). */
    downloadUrlTtlSeconds: z.coerce.number().int().positive().default(300),
    oidc: z.object({
      /** Public issuer as the browser sees it, e.g. https://localhost */
      issuer: z.string().url(),
      /** Zitadel reachable inside the compose network, e.g. http://zitadel:8080 */
      internalUrl: z.string().url(),
      /** External domain Zitadel resolves its instance by (Host header). */
      externalDomain: z.string().min(1),
    }),
    /** Written by the zitadel-init bootstrap job; served as GET /api/config. */
    webConfigFile: z.string().min(1),
    /** Optional: without it the gateway boots unconfigured and fails on use. */
    mistralApiKey: z.string().min(1).optional(),
    /** MISTRAL_EMBED_MODEL — recorded per memory; reindex re-embeds on change. */
    mistralEmbedModel: z.string().min(1).default('mistral-embed'),
    /** Per-task model tiers (decision 0007 ruling 3). */
    mistralPipelineModel: z.string().min(1).default('mistral-small-latest'),
    mistralAnswerModel: z.string().min(1).default('mistral-medium-latest'),
    logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
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
    demoAppUrl: z.string().url().default('http://app:3000'),
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
    redactionUrl: z.string().url().optional(),
  })
  .refine((c) => !c.redactionEnabled || !!c.redactionUrl, {
    message: 'REDACTION_URL is required when REDACTION_ENABLED is set',
    path: ['redactionUrl'],
  });

export type CogetoConfig = z.infer<typeof configSchema>;

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
    s3Url: env.COGETO_S3_URL,
    s3PublicUrl: env.COGETO_S3_PUBLIC_URL || undefined,
    s3AccessKey: env.COGETO_S3_ACCESS_KEY || undefined,
    s3SecretKey: env.COGETO_S3_SECRET_KEY || undefined,
    s3Bucket: env.COGETO_S3_BUCKET || undefined,
    instanceKeyDir: env.COGETO_INSTANCE_KEY_DIR || undefined,
    uploadMaxBytes: env.COGETO_UPLOAD_MAX_BYTES || undefined,
    downloadUrlTtlSeconds: env.COGETO_DOWNLOAD_URL_TTL_SECONDS || undefined,
    oidc: {
      issuer: env.COGETO_OIDC_ISSUER,
      internalUrl: env.COGETO_OIDC_INTERNAL_URL,
      externalDomain: env.COGETO_OIDC_EXTERNAL_DOMAIN,
    },
    webConfigFile: env.COGETO_WEB_CONFIG_FILE,
    // Compose passes '' when unset; treat empty as absent.
    mistralApiKey: env.COGETO_MISTRAL_API_KEY || env.MISTRAL_API_KEY || undefined,
    mistralEmbedModel: env.COGETO_MISTRAL_EMBED_MODEL || env.MISTRAL_EMBED_MODEL || undefined,
    mistralPipelineModel:
      env.COGETO_MISTRAL_MODEL_PIPELINE || env.MISTRAL_MODEL_PIPELINE || undefined,
    mistralAnswerModel: env.COGETO_MISTRAL_MODEL_ANSWER || env.MISTRAL_MODEL_ANSWER || undefined,
    logLevel: env.COGETO_LOG_LEVEL,
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
  });
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`invalid COGETO_* configuration:\n${details}`);
  }
  return parsed.data;
}

export const COGETO_CONFIG = Symbol('COGETO_CONFIG');

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
