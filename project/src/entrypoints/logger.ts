import type { LoggerService } from '@nestjs/common';
import { pino } from 'pino';
import type { Logger } from 'pino';
import { describeError } from '../infrastructure/index';

/**
 * pino-backed Nest logger. Redaction rule (Technical Architecture §7): never
 * memory content or tokens in logs — nothing here logs payloads, and the
 * redact list guards the accident paths at both the top level and one nesting
 * down. Two classes are covered: SECRETS (auth headers, bearer/API/
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
  // not smuggle a subject, body, or sender address into a line.
  'subject',
  '*.subject',
  '*.textBody',
  '*.htmlBody',
  '*.body',
  'fromAddr',
  '*.fromAddr',
  // One level deeper (audit 2.0 SEC-29). The list above stopped at depth 2, so
  // a perfectly ordinary shape — `{ job: { fact: { content } } }`,
  // `{ run: { page: { textBody } } }` — walked straight past it. pino's redact
  // paths are literal, not recursive, so each depth is spelled out; three is
  // where our own log shapes actually bottom out (job → entity → field).
  '*.*.content',
  '*.*.claim',
  '*.*.input',
  '*.*.answer',
  '*.*.prompt',
  '*.*.question',
  '*.*.subject',
  '*.*.textBody',
  '*.*.htmlBody',
  '*.*.body',
  '*.*.fromAddr',
  // Secrets, same depth. A credential nested three deep is the one that gets
  // logged by accident.
  '*.*.authorization',
  '*.*.accessToken',
  '*.*.access_token',
  '*.*.refreshToken',
  '*.*.refresh_token',
  '*.*.token',
  '*.*.apiKey',
  '*.*.api_key',
  '*.*.password',
  '*.*.secret',
];

export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // Never serialize a raw Error (stack + `received "<value>"` can carry model
    // output / secrets). Log only the class name + a length-bounded, scrubbed
    // message.
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
