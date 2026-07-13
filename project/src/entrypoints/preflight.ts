import {
  assertProductionSecrets,
  findKnownDevSecrets,
  isLocalhostDeployment,
} from './secret-preflight';

/**
 * preflight — a one-shot init container (FIX-2 QS-8) that runs BEFORE zitadel,
 * migrate, app and worker. It is the only process handed every secret env var
 * (POSTGRES/MinIO/Zitadel/KMS), so it is where "no known dev secret on a
 * reachable host" is enforced instance-wide: a misconfigured production stack
 * fails `docker compose up` loudly and early instead of silently shipping known
 * admin creds and a known at-rest master key.
 *
 * On a localhost dev box (the default) it is a no-op and exits 0.
 */
function main(): void {
  if (isLocalhostDeployment(process.env)) {
    console.log('preflight: localhost dev instance — dev secret defaults permitted');
    return;
  }
  const offenders = findKnownDevSecrets(process.env);
  if (offenders.length === 0) {
    console.log('preflight: no known dev secrets in use — deployment secrets look overridden');
    return;
  }
  // Throws with the offending variable names; the container exits non-zero and
  // compose refuses to start the dependent services.
  assertProductionSecrets(process.env);
}

try {
  main();
} catch (error) {
  console.error(`preflight failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
