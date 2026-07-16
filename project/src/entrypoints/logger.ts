import type { LoggerService } from '@nestjs/common';
import { pino } from 'pino';
import type { Logger } from 'pino';
import { describeError } from '../infrastructure/index';

/**
 * pino-backed Nest logger. Redaction rule (Technical Architecture §7): never
 * memory content or tokens in logs — nothing here logs payloads, and the
 * redact list guards the accident paths at both the top level and one nesting
 * down (QS-22). Two classes are covered: SECRETS (auth headers, bearer/API/
 * refresh tokens, passwords) and CONTENT (memory claims, model input/output,
 * user questions/answers) — a stray `{ err }` or `{ req }` cannot smuggle either
 * into a log line. The `err` serializer maps any logged Error to its class +
 * scrubbed message (no stack, no `received …` fragment).
 */
const REDACT_PATHS = [
  // Secrets — headers + token/credential fields, top level and one deep.
  'authorization',
  '*.authorization',
  '*.headers.authorization',
  'accessToken',
  '*.accessToken',
  '*.access_token',
  'refreshToken',
  '*.refreshToken',
  '*.refresh_token',
  'token',
  '*.token',
  'apiKey',
  '*.apiKey',
  '*.api_key',
  'password',
  '*.password',
  'secret',
  '*.secret',
  // Content — memory text + model I/O + conversational turns.
  'content',
  '*.content',
  'claim',
  '*.claim',
  '*.input',
  '*.answer',
  '*.prompt',
  '*.question',
  // Email content — a stray `{ email }` / `{ payload }` / reply-draft log must
  // not smuggle a subject, body, or sender address into a line (SEC-7).
  'subject',
  '*.subject',
  '*.textBody',
  '*.htmlBody',
  '*.body',
  'fromAddr',
  '*.fromAddr',
];

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // Never serialize a raw Error (stack + `received "<value>"` can carry model
    // output / secrets). Log only the class name + a length-bounded, scrubbed
    // message (QS-22).
    serializers: {
      err: (err: unknown) => describeError(err),
      error: (err: unknown) => describeError(err),
    },
  });
}

export class PinoNestLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  log(message: unknown, context?: string): void {
    this.logger.info({ context }, String(message));
  }
  error(message: unknown, trace?: string, context?: string): void {
    this.logger.error({ context, trace }, String(message));
  }
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, String(message));
  }
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, String(message));
  }
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, String(message));
  }
}
