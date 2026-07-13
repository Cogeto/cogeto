import type { Logger } from 'pino';
import type { CogetoConfig } from './config';

/**
 * Loud boot log of the EFFECTIVE redaction posture (QS-21). The process cannot
 * see which compose profiles are active, so it states plainly what it will
 * actually do: INFO when redaction is on (every outbound model call is
 * pseudonymized, fail-closed), a prominent WARN when it is off (plaintext
 * reaches the model). Paired with the `REDACTION_REQUIRED` boot gate in config,
 * an operator can no longer believe PII is protected while it silently is not.
 */
export function logRedactionState(logger: Logger, config: CogetoConfig): void {
  if (config.redactionEnabled) {
    logger.info(
      { redaction: 'on', url: config.redactionUrl },
      'redaction ON — outbound model calls are pseudonymized (fail-closed if the sidecar is unreachable)',
    );
  } else {
    logger.warn(
      { redaction: 'off' },
      'redaction OFF — model calls send PLAINTEXT to the model provider. If you intended the redaction profile, set REDACTION_ENABLED=1 (or REDACTION_REQUIRED=1 to refuse boot without it).',
    );
  }
}
