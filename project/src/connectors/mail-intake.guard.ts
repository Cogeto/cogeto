import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { MAIL_OPTIONS } from './mail-options';
import type { MailOptions } from './mail-options';

/**
 * Authenticates the internal email-intake endpoint to the mail service ONLY
 * (decision 0028 ruling 7): a shared-secret bearer the Haraka queue hook
 * presents. FAIL-CLOSED — an empty configured token denies every request, so a
 * misconfigured instance cannot accidentally expose an unauthenticated intake.
 * The endpoint is never public (it opts out of the global bearer guard via
 * @Public and applies this instead).
 */
@Injectable()
export class MailIntakeGuard implements CanActivate {
  constructor(@Inject(MAIL_OPTIONS) private readonly options: MailOptions) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.options.intakeToken;
    if (!expected) throw new UnauthorizedException('email intake is not configured');

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException('missing intake token');
    const presented = header.slice('Bearer '.length);

    // Constant-time compare (length-guarded so timingSafeEqual never throws).
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('invalid intake token');
    }
    return true;
  }
}
