import { describe, expect, it } from 'vitest';
import { DEFAULT_SPACE_ID } from '@cogeto/shared';
import type { Principal, SpaceDto } from '@cogeto/shared';
import { SpacesController } from './spaces.controller';
import type { MachineBindingService } from './machine-binding.service';
import type { SpaceErasureService } from './space-erasure.service';
import type { SpaceService } from './space.service';

/**
 * GET /api/spaces resolves the list and the last-used pointer in parallel, so
 * a space deleted BETWEEN the two reads could hand the client a current space
 * the list does not contain — which the SPA would bind for up to a poll
 * interval (spaces verification F13). The pointer degrades against the list
 * the client renders, the same way a deleted last-used space degrades to the
 * default server-side.
 */

const principal = {
  userId: 'user-1',
  name: 'User',
  email: null,
  orgId: 'org-1',
  orgName: 'Org',
  roles: [],
} as Principal;

const SPACES: SpaceDto[] = [
  { id: DEFAULT_SPACE_ID, name: 'Default', createdAt: new Date().toISOString() },
  {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Alpha',
    createdAt: new Date().toISOString(),
  },
];

function controllerWith(currentSpaceId: string): SpacesController {
  const spaces = {
    list: async () => SPACES,
    currentFor: async () => currentSpaceId,
  } as unknown as SpaceService;
  return new SpacesController(
    spaces,
    {} as SpaceErasureService,
    {} as unknown as MachineBindingService,
  );
}

describe('spaces_list_never_names_a_current_outside_itself', () => {
  it('keeps a pointer the list contains', async () => {
    const result = await controllerWith('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').list({
      principal,
    } as never);
    expect(result.currentSpaceId).toBe('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  });

  it('degrades a pointer the list does not contain to the default space', async () => {
    const result = await controllerWith('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb').list({
      principal,
    } as never);
    expect(result.currentSpaceId).toBe(DEFAULT_SPACE_ID);
  });
});
