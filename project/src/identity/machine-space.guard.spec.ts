import { describe, expect, it } from 'vitest';
import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { DEFAULT_SPACE_ID, resolveSpaceId } from '@cogeto/shared';
import type { Principal } from '@cogeto/shared';
import { BearerAuthGuard } from './bearer-auth.guard';
import type { IdentityService } from './identity.service';
import type { MachineSpaceBindings } from './machine-space-bindings.port';

/**
 * Machine callers carry a space (docs/features/spaces.md section 6c), proved
 * at the guard: a machine principal (a token that resolved without a human
 * profile, i.e. no email claim) has NO ambient default. Unbound is refused naming the requirement; a header that
 * disagrees with the binding is refused, never honored; a header that
 * restates the binding is accepted; and a root wired without the binding
 * adapter refuses every machine (fail closed). Humans are untouched: absent
 * header still resolves to the default space, a header still rides.
 */

const SPACE_A = '11111111-1111-4111-8111-111111111111';
const SPACE_B = '22222222-2222-4222-8222-222222222222';

const human: Principal = {
  userId: 'user-h',
  name: 'Ana',
  email: 'ana@instance.test',
  orgId: 'org',
  orgName: 'Org',
  roles: [],
};
const machine: Principal = {
  userId: 'svc-1',
  name: 'integration',
  email: null,
  orgId: 'org',
  orgName: 'Org',
  roles: [],
};

function guardFor(
  principal: Principal,
  binding: string | null | undefined,
): { guard: BearerAuthGuard; contextWith: (space?: string) => ExecutionContext } {
  const identity = {
    resolvePrincipal: async () => principal,
  } as unknown as IdentityService;
  const bindings: MachineSpaceBindings | undefined =
    binding === undefined ? undefined : { spaceFor: async () => binding };
  const guard = new BearerAuthGuard(identity, new Reflector(), bindings);
  const contextWith = (space?: string): ExecutionContext => {
    const request = {
      headers: {
        authorization: 'Bearer token',
        ...(space ? { 'x-cogeto-space': space } : {}),
      },
    } as unknown as Record<string, unknown>;
    return {
      getHandler: () => function handler() {},
      getClass: () => class Ctrl {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;
  };
  return { guard, contextWith };
}

async function principalAfter(
  guard: BearerAuthGuard,
  context: ExecutionContext,
): Promise<Principal> {
  await guard.canActivate(context);
  const request = context.switchToHttp().getRequest<{ principal: Principal }>();
  return request.principal;
}

describe('machine callers carry a space (the guard)', () => {
  it('machine_without_a_binding_is_refused_naming_the_requirement', async () => {
    const { guard, contextWith } = guardFor(machine, null);
    await expect(guard.canActivate(contextWith())).rejects.toThrow(
      /machine callers must be bound to a space.*machine-bindings\/svc-1/,
    );
  });

  it('machine_without_the_adapter_wired_is_refused: fail closed, never a default', async () => {
    const { guard, contextWith } = guardFor(machine, undefined);
    await expect(guard.canActivate(contextWith())).rejects.toThrow(
      /machine callers must be bound to a space/,
    );
    // Even an explicit header cannot substitute for the binding.
    await expect(guard.canActivate(contextWith(SPACE_A))).rejects.toThrow(
      /machine callers must be bound to a space/,
    );
  });

  it('a_bound_machine_acts_in_its_binding: the credential is the space', async () => {
    const { guard, contextWith } = guardFor(machine, SPACE_A);
    const principal = await principalAfter(guard, contextWith());
    expect(principal.spaceId).toBe(SPACE_A);
    expect(resolveSpaceId(principal)).toBe(SPACE_A);
  });

  it('a_header_may_only_restate_the_binding: a disagreeing one is refused, never honored', async () => {
    const { guard, contextWith } = guardFor(machine, SPACE_A);
    await expect(guard.canActivate(contextWith(SPACE_B))).rejects.toThrow(
      /bound to a different space/,
    );
    const principal = await principalAfter(guard, contextWith(SPACE_A));
    expect(principal.spaceId).toBe(SPACE_A);
  });

  it('humans_are_untouched: absent header resolves to the default space, a header rides', async () => {
    const { guard, contextWith } = guardFor(human, null);
    const absent = await principalAfter(guard, contextWith());
    expect(absent.spaceId).toBeUndefined();
    expect(resolveSpaceId(absent)).toBe(DEFAULT_SPACE_ID);
    const withHeader = await principalAfter(guard, contextWith(SPACE_B));
    expect(withHeader.spaceId).toBe(SPACE_B);
  });
});
