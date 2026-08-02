import { Module } from '@nestjs/common';
import { UserContextService } from './user-context';

/**
 * Provides the per-user context and language preference.
 *
 * **Not global** (V2.0 item 3.6, `docs/module-boundary-contract.md` §4). It was,
 * which meant chat, dreaming, the settings surface and the skill engine each
 * had a dependency on it that no module declared and the import graph could not
 * see. A static module exporting one service has no claim on the global
 * exemption: every consumer now imports it, and `@Optional()` arguments that
 * used to resolve by ambient luck resolve because a module said so.
 *
 * DRIZZLE still comes from the global DatabaseModule (one pool per process,
 * which is what the exemption is for).
 */
@Module({ providers: [UserContextService], exports: [UserContextService] })
export class UserContextModule {}
