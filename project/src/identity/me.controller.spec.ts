import { describe, expect, it } from 'vitest';
import type { Principal } from '@cogeto/shared';
import { MeController } from './me.controller';
import type { AuthenticatedRequest } from './bearer-auth.guard';
import type { IdentityOptions } from './identity-options';

/**
 * o6-dry-run: /api/me carries the server-computed isAdmin flag so the SPA can
 * hide the System view from plain users (the dry run walked a customer user
 * into raw 403s). The flag respects the CONFIGURED admin role, never a
 * hardcoded name.
 */
const options = (adminRole?: string): IdentityOptions => ({
  internalBaseUrl: 'http://zitadel:8080',
  externalDomain: 'localhost',
  cacheTtlSeconds: 10,
  ...(adminRole ? { adminRole } : {}),
});

const principal = (roles: string[]): Principal => ({
  userId: 'u1',
  name: 'User',
  email: 'u1@example.test',
  orgId: 'o1',
  orgName: 'Org',
  roles,
});

const request = (roles: string[]) => ({ principal: principal(roles) }) as AuthenticatedRequest;

describe('MeController', () => {
  it('flags the configured admin role as isAdmin', () => {
    const controller = new MeController(options());
    expect(controller.me(request(['admin'])).isAdmin).toBe(true);
    expect(controller.me(request([])).isAdmin).toBe(false);
    expect(controller.me(request(['other'])).isAdmin).toBe(false);
  });

  it('respects a custom COGETO_ADMIN_ROLE instead of hardcoding "admin"', () => {
    const controller = new MeController(options('operator'));
    expect(controller.me(request(['operator'])).isAdmin).toBe(true);
    expect(controller.me(request(['admin'])).isAdmin).toBe(false);
  });

  it('still returns the full Principal alongside the flag', () => {
    const me = new MeController(options()).me(request(['admin']));
    expect(me.userId).toBe('u1');
    expect(me.orgName).toBe('Org');
    expect(me.roles).toEqual(['admin']);
  });
});
