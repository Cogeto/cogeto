/**
 * Known-dev-secret refusal (FIX-2 QS-8). The compose stack ships working DEV
 * defaults so a fresh clone runs with zero configuration — but those exact
 * values must never guard a reachable deployment. This preflight refuses to
 * boot when any known dev secret is still in place AND the instance is not a
 * localhost dev box.
 *
 * "Localhost" is inferred from the external domain: `localhost` / `127.0.0.1` /
 * `*.localhost` (the dev *.localhost console vhosts) are dev; anything else is a
 * real deployment that must inject real secrets (Technical Architecture §10).
 *
 * The check is skipped per-variable when the variable is absent, so it serves
 * both the app/worker (which see a subset — the DB URL and S3 creds) and the
 * dedicated `preflight` init container (which is given every secret). Pure and
 * env-injected so it is unit-testable.
 */

/** One known-dev secret: the env var, its committed dev value, and a matcher. */
interface KnownDevSecret {
  env: string;
  /** The exact committed dev value (docker-compose.yml / .env.example). */
  devValue: string;
  /** `contains` matches when the var merely EMBEDS the value (e.g. a DB URL). */
  match: 'equals' | 'contains';
}

/**
 * The committed dev values from docker-compose.yml (QS-8 evidence). Kept in one
 * place so a rotation of any default only needs updating here.
 */
export const KNOWN_DEV_SECRETS: readonly KnownDevSecret[] = [
  { env: 'POSTGRES_PASSWORD', devValue: 'cogeto-dev-password', match: 'equals' },
  { env: 'COGETO_DATABASE_URL', devValue: 'cogeto-dev-password', match: 'contains' },
  { env: 'MINIO_ROOT_PASSWORD', devValue: 'cogeto-dev-password', match: 'equals' },
  { env: 'COGETO_S3_SECRET_KEY', devValue: 'cogeto-dev-password', match: 'equals' },
  {
    env: 'MINIO_KMS_SECRET_KEY',
    devValue: 'cogeto-dev-key:bxaADytwX4au7d/HYGegSGd0uloQlb30uz6Vh5opUvg=',
    match: 'equals',
  },
  { env: 'ZITADEL_MASTERKEY', devValue: 'MasterkeyNeedsToHave32Characters', match: 'equals' },
  { env: 'ZITADEL_DB_PASSWORD', devValue: 'zitadel-dev-password', match: 'equals' },
  { env: 'ZITADEL_ADMIN_PASSWORD', devValue: 'DevPassword1!', match: 'equals' },
] as const;

/** True when the external domain is a local dev box (dev defaults are allowed). */
export function isLocalhostDeployment(env: NodeJS.ProcessEnv): boolean {
  const domain = (env.COGETO_EXTERNAL_DOMAIN ?? env.COGETO_OIDC_EXTERNAL_DOMAIN ?? '')
    .trim()
    .toLowerCase();
  if (!domain) return true; // unknown → treat as local (bare tooling / tests)
  return domain === 'localhost' || domain === '127.0.0.1' || domain.endsWith('.localhost');
}

/** Returns the env-var names still set to a known dev value (present vars only). */
export function findKnownDevSecrets(env: NodeJS.ProcessEnv): string[] {
  const offenders: string[] = [];
  for (const secret of KNOWN_DEV_SECRETS) {
    const value = env[secret.env];
    if (value === undefined || value === '') continue;
    const hit =
      secret.match === 'equals' ? value === secret.devValue : value.includes(secret.devValue);
    if (hit) offenders.push(secret.env);
  }
  return offenders;
}

/**
 * Throws when the instance is a real (non-localhost) deployment still using any
 * committed dev secret. A no-op on a localhost dev box or when every secret has
 * been overridden.
 */
export function assertProductionSecrets(env: NodeJS.ProcessEnv = process.env): void {
  if (isLocalhostDeployment(env)) return;
  const offenders = findKnownDevSecrets(env);
  if (offenders.length === 0) return;
  throw new Error(
    `refusing to boot: known DEV secret value(s) in use on a non-localhost deployment ` +
      `(COGETO_EXTERNAL_DOMAIN is not localhost) — override before exposing this instance: ` +
      offenders.join(', ') +
      ` (QS-8; see .env.example and Technical Architecture §10)`,
  );
}
