import { Scope } from '@nestjs/common';
import type { Provider } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import type { Principal } from '@cogeto/shared';
import type { AuthenticatedRequest } from './bearer-auth.guard';

/**
 * Request-scoped Principal (S1-B §4): modules inject PRINCIPAL instead of
 * reaching into the request. Populated by the BearerAuthGuard; null on
 * unguarded routes.
 */
export const PRINCIPAL = Symbol('PRINCIPAL');

export const principalProvider: Provider = {
  provide: PRINCIPAL,
  scope: Scope.REQUEST,
  inject: [REQUEST],
  useFactory: (request: AuthenticatedRequest): Principal | null => request.principal ?? null,
};
