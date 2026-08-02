import { UnauthorizedException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { MailIntakeGuard } from './mail-intake.guard';
import type { MailOptions } from './mail-options';

/**
 * GAP-8: the intake endpoint is the one @Public, internet-adjacent route, so its
 * shared-secret guard must be exercised directly — a wiring regression (a
 * dropped guard, an empty token accepted) would silently expose unauthenticated
 * intake, and no other test covers it.
 */
const baseOptions = (over: Partial<MailOptions>): MailOptions => ({
  inboundAddress: 'capture@in.test',
  maxBytes: 1000,
  attachmentsMaxBytes: 1000,
  adminUserEmail: null,
  intakeToken: 'the-secret',
  requireAuthenticatedSender: true,
  intakeMaxPerSenderPerWindow: 60,
  intakeRateWindowSeconds: 3600,
  ...over,
});

const ctxWith = (authorization?: string): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers: { authorization } }) }),
  }) as unknown as ExecutionContext;

describe('MailIntakeGuard (GAP-8)', () => {
  it('accepts the exact configured bearer token', () => {
    const guard = new MailIntakeGuard(baseOptions({ intakeToken: 'the-secret' }));
    expect(guard.canActivate(ctxWith('Bearer the-secret'))).toBe(true);
  });

  it('rejects a wrong token', () => {
    const guard = new MailIntakeGuard(baseOptions({ intakeToken: 'the-secret' }));
    expect(() => guard.canActivate(ctxWith('Bearer wrong'))).toThrow(UnauthorizedException);
  });

  it('rejects a missing / non-bearer Authorization header', () => {
    const guard = new MailIntakeGuard(baseOptions({ intakeToken: 'the-secret' }));
    expect(() => guard.canActivate(ctxWith(undefined))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctxWith('Basic the-secret'))).toThrow(UnauthorizedException);
  });

  it('FAILS CLOSED when no token is configured — even a matching empty bearer is denied', () => {
    const guard = new MailIntakeGuard(baseOptions({ intakeToken: '' }));
    expect(() => guard.canActivate(ctxWith('Bearer '))).toThrow(UnauthorizedException);
    expect(() => guard.canActivate(ctxWith('Bearer anything'))).toThrow(UnauthorizedException);
  });

  it('rejects a token that is a prefix of the secret (length-guarded compare)', () => {
    const guard = new MailIntakeGuard(baseOptions({ intakeToken: 'the-secret' }));
    expect(() => guard.canActivate(ctxWith('Bearer the-secr'))).toThrow(UnauthorizedException);
  });
});
