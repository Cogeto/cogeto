import { Module } from '@nestjs/common';
import { PassportExportCascade } from './passport.source-expiry';

/**
 * Provides the passport arm of the deletion saga (audit 2.0 SEC-8). Deliberately
 * dependency-free: the cascade works entirely inside the transaction the saga
 * hands it, so registering it cannot pull the passport module's own wiring
 * (object store, signer, worker options) into the memory module's graph.
 */
@Module({
  providers: [PassportExportCascade],
  exports: [PassportExportCascade],
})
export class PassportCascadeModule {}
