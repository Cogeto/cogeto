import { ForbiddenException } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { AdminGuard } from './admin.guard';
import type { Principal } from '@cogeto/shared';

/**
 * QS-10 — the jobs (System view) endpoints are admin-only. AdminGuard runs after
 * the global bearer guard has attached the Principal and requires the configured
 * admin role; a member without it is refused.
 */
const contextFor = (roles: string[]): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ principal: { roles } as unknown as Principal }),
    }),
  }) as unknown as ExecutionContext;

describe('AdminGuard (QS-10)', () => {
  it('allows a principal carrying the configured admin role', () => {
    const guard = new AdminGuard({ adminRole: 'admin' } as never);
    expect(guard.canActivate(contextFor(['member', 'admin']))).toBe(true);
  });

  it('refuses a principal without the admin role', () => {
    const guard = new AdminGuard({ adminRole: 'admin' } as never);
    expect(() => guard.canActivate(contextFor(['member']))).toThrow(ForbiddenException);
  });

  it('honours a custom admin role name', () => {
    const guard = new AdminGuard({ adminRole: 'operator' } as never);
    expect(guard.canActivate(contextFor(['operator']))).toBe(true);
    expect(() => guard.canActivate(contextFor(['admin']))).toThrow(ForbiddenException);
  });

  it('defaults to "admin" when no role is configured', () => {
    const guard = new AdminGuard({} as never);
    expect(guard.canActivate(contextFor(['admin']))).toBe(true);
    expect(() => guard.canActivate(contextFor([]))).toThrow(ForbiddenException);
  });
});
