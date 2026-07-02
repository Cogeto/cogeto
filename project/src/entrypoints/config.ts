import { z } from 'zod';

/**
 * Typed process configuration (research: project-structure-lessons §4).
 * COGETO_-prefixed env vars, validated once at boot — a misconfigured instance
 * fails to start, not on request. Only entrypoints read the environment;
 * modules receive options through their registration APIs.
 */
const configSchema = z.object({
  httpPort: z.coerce.number().int().positive().default(3000),
  databaseUrl: z.string().min(1),
  qdrantUrl: z.string().url(),
  s3Url: z.string().url(),
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
  logLevel: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type CogetoConfig = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CogetoConfig {
  const parsed = configSchema.safeParse({
    httpPort: env.COGETO_HTTP_PORT,
    databaseUrl: env.COGETO_DATABASE_URL,
    qdrantUrl: env.COGETO_QDRANT_URL,
    s3Url: env.COGETO_S3_URL,
    oidc: {
      issuer: env.COGETO_OIDC_ISSUER,
      internalUrl: env.COGETO_OIDC_INTERNAL_URL,
      externalDomain: env.COGETO_OIDC_EXTERNAL_DOMAIN,
    },
    webConfigFile: env.COGETO_WEB_CONFIG_FILE,
    // Compose passes '' when unset; treat empty as absent.
    mistralApiKey: env.COGETO_MISTRAL_API_KEY || env.MISTRAL_API_KEY || undefined,
    logLevel: env.COGETO_LOG_LEVEL,
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
