import { Global, Module } from '@nestjs/common';
import { UserContextService } from './user-context';

/**
 * Provides the per-user context as a GLOBAL module — like LimitsModule —
 * so chat, retrieval, dreaming and the settings surface can inject it
 * without any module importing an entrypoint. Registered once by each
 * composition root; DRIZZLE comes from the global DatabaseModule.
 */
@Global()
@Module({ providers: [UserContextService], exports: [UserContextService] })
export class UserContextModule {}
