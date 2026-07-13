import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Principal } from '@cogeto/shared';
import { setUsageUser } from '../infrastructure/index';
import { IdentityService } from './identity.service';
import { IS_PUBLIC_KEY } from './public.decorator';

export interface AuthenticatedRequest extends Request {
  principal: Principal;
}

/**
 * Guards API routes: extracts the Bearer token and attaches the Principal.
 * Registered as a GLOBAL guard (APP_GUARD, QS-18), so authentication is
 * DEFAULT-DENY — a controller is protected without remembering `@UseGuards`.
 * The four intentionally-public routes opt out with `@Public()`.
 */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    private readonly identity: IdentityService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    request.principal = await this.identity.resolvePrincipal(header.slice('Bearer '.length));
    // Attribute this request's model calls to the principal (FIX-2 QS-2): fills
    // in the per-request usage scope opened by the app's middleware, so the
    // gateway budget decorator can meter/cap by user without a seam change.
    setUsageUser(request.principal.userId);
    return true;
  }
}
