import { Inject, Injectable, Module } from '@nestjs/common';
import { asc, eq } from 'drizzle-orm';
import type { MachineSpaceBindingDto, Principal } from '@cogeto/shared';
import { DRIZZLE, userError, writeAudit } from '../infrastructure/index';
import type { Db } from '../infrastructure/index';
import type { MachineSpaceBindings } from '../identity/index';
import { machineSpaceBinding, space } from './persistence/tables';
import type { MachineSpaceBindingRow } from './persistence/tables';

/**
 * Machine callers' per-credential space bindings (docs/features/spaces.md
 * section 6c): a machine principal is refused at the guard unless an
 * administrator has bound its user id to exactly one space, and that binding
 * IS its space. Management is administrator-only (the routes carry the
 * AdminGuard); the lookup implements the identity seam's port, bound by the
 * composition roots (the SpaceNameResolver precedent, spec §15 rule 2).
 */
@Injectable()
export class MachineBindingService implements MachineSpaceBindings {
  constructor(@Inject(DRIZZLE) private readonly db: Db) {}

  async spaceFor(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ spaceId: machineSpaceBinding.spaceId })
      .from(machineSpaceBinding)
      .where(eq(machineSpaceBinding.userId, userId))
      .limit(1);
    return rows[0]?.spaceId ?? null;
  }

  async list(): Promise<MachineSpaceBindingDto[]> {
    const rows = await this.db
      .select()
      .from(machineSpaceBinding)
      .orderBy(asc(machineSpaceBinding.createdAt));
    return rows.map(toBindingDto);
  }

  /** Bind (or re-bind) a machine user to a space. Audited. */
  async bind(
    principal: Principal,
    userId: string,
    spaceId: string,
  ): Promise<MachineSpaceBindingDto> {
    const exists = await this.db
      .select({ id: space.id })
      .from(space)
      .where(eq(space.id, spaceId))
      .limit(1);
    if (!exists[0]) throw userError.notFound('spaces.notFound', 'that space no longer exists');
    const [row] = await this.db
      .insert(machineSpaceBinding)
      .values({ userId, spaceId, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: machineSpaceBinding.userId,
        set: { spaceId, updatedAt: new Date() },
      })
      .returning();
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action: 'space.machine_bound',
      entityType: 'machine_space_binding',
      entityId: userId,
      detail: {},
      ownerId: principal.userId,
      orgId: principal.orgId,
      spaceId,
    });
    return toBindingDto(row!);
  }

  /** Remove a binding; the machine is then refused (fail closed). Audited. */
  async unbind(principal: Principal, userId: string): Promise<boolean> {
    const [deleted] = await this.db
      .delete(machineSpaceBinding)
      .where(eq(machineSpaceBinding.userId, userId))
      .returning({ userId: machineSpaceBinding.userId, spaceId: machineSpaceBinding.spaceId });
    if (!deleted) return false;
    await writeAudit(this.db, {
      actor: `user:${principal.userId}`,
      action: 'space.machine_unbound',
      entityType: 'machine_space_binding',
      entityId: userId,
      detail: {},
      ownerId: principal.userId,
      orgId: principal.orgId,
      spaceId: deleted.spaceId,
    });
    return true;
  }
}

function toBindingDto(row: MachineSpaceBindingRow): MachineSpaceBindingDto {
  return {
    userId: row.userId,
    spaceId: row.spaceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Standalone binding module, so a root can hand the adapter to the identity
 * seam's registration without pulling the whole spaces surface into that
 * scope (the SpaceNameModule shape). */
@Module({ providers: [MachineBindingService], exports: [MachineBindingService] })
export class MachineBindingModule {}
