import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Principal } from '@cogeto/shared';
import { setUsageUser } from '../infrastructure/index';
import { IdentityService } from './identity.service';

export interface AuthenticatedRequest extends Request {
  principal: Principal;
}

/** Guards API routes: extracts the Bearer token and attaches the Principal. */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(private readonly identity: IdentityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
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
