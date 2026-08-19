import { readFileSync } from 'node:fs';
import { Inject, Injectable, Optional } from '@nestjs/common';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { resolveSpaceId, SPACE_HEADER } from '@cogeto/shared';
import type { Principal } from '@cogeto/shared';
import { setUsageUser, untranslatedError } from '../infrastructure/index';
import { IdentityService } from './identity.service';
import { IS_PUBLIC_KEY } from './public.decorator';
import { MACHINE_SPACE_BINDINGS } from './machine-space-bindings.port';
import type { MachineSpaceBindings } from './machine-space-bindings.port';
import { WEB_CONFIG_OPTIONS } from './identity-options';
import type { WebConfigOptions } from './identity-options';

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
    /** Machine callers' per-credential space bindings
     * (docs/features/spaces.md section 6c). Optional: a root without the
     * binding refuses every machine principal (fail closed). */
    @Optional()
    @Inject(MACHINE_SPACE_BINDINGS)
    private readonly machineBindings?: MachineSpaceBindings,
    /** Demo-sandbox context (section 6c): the demo Principal IS a Zitadel
     * machine user whose PAT the sandbox publishes as the browser session,
     * so in demo mode, and only there, that ONE principal is the interface
     * user and not a machine caller. Optional: only the app root serving
     * the sandbox passes webConfig. */
    @Optional()
    @Inject(WEB_CONFIG_OPTIONS)
    private readonly webConfig?: WebConfigOptions,
  ) {}

  /**
   * The published demo principal's user id, or null. Read fresh per
   * machine-classified request, demo mode only: the file is tiny, the seed
   * rewrites it on reset, and caching a miss would refuse the sandbox's own
   * bootstrap. Unreadable or absent fails CLOSED (the machine rule applies).
   */
  private demoPrincipalId(): string | null {
    if (!this.webConfig?.demoMode) return null;
    try {
      const parsed = JSON.parse(readFileSync(this.webConfig.demoSessionFile, 'utf8')) as {
        ownerId?: unknown;
      };
      return typeof parsed.ownerId === 'string' && parsed.ownerId ? parsed.ownerId : null;
    } catch {
      return null;
    }
  }

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
    //
    // A MACHINE principal has no ambient default (section 6c): its space IS
    // its administrator-managed binding. A machine is a token that resolved
    // WITHOUT a human profile (no email claim): human users authenticate
    // through the interface with the email scope, so their tokens always
    // carry one (the demo PAT included); Zitadel service users carry none.
    // Unbound → refused, naming the requirement. A header that disagrees
    // with the binding → refused, never honored: a token bound to one space
    // cannot reach another by any parameter. Errors stay untranslated (a
    // machine client, F13's third case).
    const headerSpace = spaceIdFrom(request);
    let spaceId = headerSpace;
    if (principal.email === null && principal.userId !== this.demoPrincipalId()) {
      const bound = (await this.machineBindings?.spaceFor(principal.userId)) ?? null;
      if (!bound) {
        throw untranslatedError.forbidden(
          'machine callers must be bound to a space: ask an administrator to bind this ' +
            `service user via PUT /api/spaces/machine-bindings/${principal.userId}`,
        );
      }
      if (headerSpace !== undefined && headerSpace !== bound) {
        throw untranslatedError.forbidden(
          `this credential is bound to a different space; the ${SPACE_HEADER} header may ` +
            'only restate the binding or be absent',
        );
      }
      spaceId = bound;
    }
    request.principal = { ...principal, spaceId };
    // Attribute this request's model calls to the principal: fills
    // in the per-request usage scope opened by the app's middleware, so the
    // gateway budget decorator can meter/cap by user without a seam change.
    // The space rides the scope for ATTRIBUTION only (the model-egress audit
    // entry); caps stay instance-wide by owner decision. Resolved here so an
    // absent header attributes to the default space, which is what it is.
    setUsageUser(
      request.principal.userId,
      request.principal.orgId,
      resolveSpaceId(request.principal),
    );
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
