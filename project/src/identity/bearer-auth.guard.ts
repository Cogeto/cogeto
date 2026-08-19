import { Injectable } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { SPACE_HEADER } from '@cogeto/shared';
import type { Principal } from '@cogeto/shared';
import { setUsageUser, untranslatedError } from '../infrastructure/index';
import { IdentityService } from './identity.service';
import { IS_PUBLIC_KEY } from './public.decorator';

export interface AuthenticatedRequest extends Request {
  principal: Principal;
}

/**
 * Guards API routes: extracts the Bearer token and attaches the Principal.
 * Registered as a GLOBAL guard (APP_GUARD), so authentication is
 * DEFAULT-DENY — a controller is protected without remembering `@UseGuards`.
 * The four intentionally-public routes opt out with `@Public`.
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
      throw untranslatedError.unauthorized('missing bearer token');
    }
    const principal = await this.identity.resolvePrincipal(header.slice('Bearer '.length));
    // The caller's current space (docs/features/spaces.md), read per request
    // from the space header. ALWAYS a spread onto a fresh object: the resolved
    // principal is cached and shared across requests, and the space changes
    // per request, so mutating it would leak one request's space into another.
    // A well-formed but unknown id is deliberately NOT resolved against the
    // database here (the identity seam imports no domain module): reads under
    // it gate to nothing (fail closed) and writes FK-fail loudly, and absence
    // means the default space via resolveSpaceId.
    request.principal = { ...principal, spaceId: spaceIdFrom(request) };
    // Attribute this request's model calls to the principal: fills
    // in the per-request usage scope opened by the app's middleware, so the
    // gateway budget decorator can meter/cap by user without a seam change.
    setUsageUser(request.principal.userId, request.principal.orgId);
    return true;
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The space header's value, validated as a uuid, or undefined when absent. */
function spaceIdFrom(request: Request): string | undefined {
  const raw = request.headers[SPACE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined || value === '') return undefined;
  if (!UUID_PATTERN.test(value)) {
    throw untranslatedError.badRequest(`${SPACE_HEADER} must be a space id (uuid)`);
  }
  return value.toLowerCase();
}
