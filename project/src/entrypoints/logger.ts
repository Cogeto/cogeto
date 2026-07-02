import type { LoggerService } from '@nestjs/common';
import { pino } from 'pino';
import type { Logger } from 'pino';

/**
 * pino-backed Nest logger. Redaction rule (Technical Architecture §7): never
 * memory content or tokens in logs — nothing here logs payloads, and the
 * redact list guards the obvious accident paths.
 */
export function createLogger(level: string): Logger {
  return pino({
    level,
    redact: {
      paths: ['*.authorization', '*.accessToken', '*.token', '*.content'],
      censor: '[redacted]',
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
