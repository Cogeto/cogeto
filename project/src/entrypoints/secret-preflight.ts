/**
 * Known-dev-secret refusal. The compose stack ships working DEV
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
 * The committed dev values from docker-compose.yml (evidence). Kept in one
 * place so a rotation of any default only needs updating here.
 */
export const KNOWN_DEV_SECRETS: readonly KnownDevSecret[] = [
  { env: 'POSTGRES_PASSWORD', devValue: 'cogeto-dev-password', match: 'equals' },
  { env: 'COGETO_DATABASE_URL', devValue: 'cogeto-dev-password', match: 'contains' },
  // Wave-3 least-privilege credentials (SEC-1/SEC-2): the split DB roles, the
  // Zitadel bootstrap DB admin, and the scoped S3 credential each carry their
  // own dev default, refused on a reachable host like every other.
  { env: 'COGETO_APP_DB_PASSWORD', devValue: 'cogeto-dev-app-db-password', match: 'equals' },
  { env: 'COGETO_DATABASE_URL', devValue: 'cogeto-dev-app-db-password', match: 'contains' },
  { env: 'COGETO_DATABASE_URL', devValue: 'cogeto-dev-migrate-db-password', match: 'contains' },
  {
    env: 'COGETO_MIGRATE_DB_PASSWORD',
    devValue: 'cogeto-dev-migrate-db-password',
    match: 'equals',
  },
  { env: 'ZITADEL_DB_ADMIN_PASSWORD', devValue: 'zitadel-dev-admin-password', match: 'equals' },
  { env: 'MINIO_ROOT_PASSWORD', devValue: 'cogeto-dev-password', match: 'equals' },
  { env: 'COGETO_S3_SECRET_KEY', devValue: 'cogeto-dev-password', match: 'equals' },
  { env: 'COGETO_S3_SECRET_KEY', devValue: 'cogeto-dev-app-password', match: 'equals' },
  {
    env: 'MINIO_KMS_SECRET_KEY',
    devValue: 'cogeto-dev-key:bxaADytwX4au7d/HYGegSGd0uloQlb30uz6Vh5opUvg=',
    match: 'equals',
  },
  { env: 'ZITADEL_MASTERKEY', devValue: 'MasterkeyNeedsToHave32Characters', match: 'equals' },
  { env: 'ZITADEL_DB_PASSWORD', devValue: 'zitadel-dev-password', match: 'equals' },
  { env: 'ZITADEL_ADMIN_PASSWORD', devValue: 'DevPassword1!', match: 'equals' },
  // The inbound-mail intake shared secret (/PA-19). The supported deploy
  // path already requires it (deploy compose uses `:?`; the operator script
  // generates one), but a hand-rolled non-localhost run of the DEV compose would
  // otherwise ship this known token — so it fails closed here like the rest.
  { env: 'COGETO_MAIL_INTAKE_TOKEN', devValue: 'cogeto-dev-mail-token', match: 'equals' },
  // SearXNG's session/image-proxy secret (audit 2.0 SEC-21). Internal-network
  // only, so the blast radius is small — but it is a committed default guarding
  // a running service, and the point of this list is that NO known dev value
  // survives onto a reachable deployment. `cogeto features enable research`
  // generates a real one; this makes forgetting it fail closed.
  { env: 'SEARXNG_SECRET', devValue: 'cogeto-dev-searxng-secret', match: 'equals' },
] as const;

/**
 * A secret that an ACTIVE compose profile cannot run safely without (audit
 * F12). The known-dev-secret list above refuses a secret set to a value nobody
 * should use; this refuses a secret set to NO value at all, which the list
 * above cannot see because it skips empty variables by design (it serves
 * processes that are handed only a subset).
 *
 * Both composes deliberately supply `${SEARXNG_SECRET:-}`: compose interpolates
 * the whole file before profile filtering, so a required-variable form would
 * break `compose up` with research OFF. That default is why an operator who
 * adds `research` to COMPOSE_PROFILES by hand, rather than through
 * `cogeto features enable research`, gets a SearXNG with no session and
 * image-proxy secret and no complaint from anything.
 */
interface ProfileSecret {
  /** The compose profile whose service needs it. */
  profile: string;
  /** The explicit per-capability flag that also activates it (CLI --profile is
   * invisible to a container, so the capability flags exist for that case). */
  enabledFlag?: string;
  env: string;
  why: string;
}

export const PROFILE_REQUIRED_SECRETS: readonly ProfileSecret[] = [
  {
    profile: 'research',
    enabledFlag: 'COGETO_RESEARCH_ENABLED',
    env: 'SEARXNG_SECRET',
    why:
      'SearXNG signs its session cookies and image-proxy URLs with it; empty means ' +
      "unsigned. Generate one with 'cogeto features enable research', or set it in .env",
  },
] as const;

/** The active compose profiles, as the container can see them (P6.7: the list
 * is mirrored in, because a container cannot read its own profiles). */
function activeProfiles(env: NodeJS.ProcessEnv): string[] {
  return (env.COGETO_COMPOSE_PROFILES ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/** Returns the profile-required secrets that are active but empty or unset. */
export function findEmptyProfileSecrets(env: NodeJS.ProcessEnv): string[] {
  const profiles = activeProfiles(env);
  return PROFILE_REQUIRED_SECRETS.filter(
    (secret) => profiles.includes(secret.profile) || env[secret.enabledFlag ?? ''] === '1',
  )
    .filter((secret) => (env[secret.env] ?? '').trim() === '')
    .map((secret) => secret.env);
}

/**
 * Throws when an ACTIVE profile's required secret is empty. Unlike the dev-secret
 * refusal this applies on a localhost box too: the dev compose supplies a working
 * default, so the only way to reach it is to have blanked the value deliberately,
 * and an unsigned session is not more acceptable on a laptop than in production.
 */
export function assertProfileSecrets(env: NodeJS.ProcessEnv = process.env): void {
  const missing = findEmptyProfileSecrets(env);
  if (missing.length === 0) return;
  const detail = PROFILE_REQUIRED_SECRETS.filter((secret) => missing.includes(secret.env))
    .map((secret) => `${secret.env} (profile '${secret.profile}'): ${secret.why}`)
    .join('; ');
  throw new Error(
    `refusing to boot: an active compose profile requires a secret that is empty: ${detail}`,
  );
}

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
      `(COGETO_EXTERNAL_DOMAIN is not localhost), override before exposing this instance: ` +
      offenders.join(', ') +
      ` (see .env.example and Technical Architecture §10)`,
  );
}
