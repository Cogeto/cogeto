import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata, Provider } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { CapabilitiesService } from './capabilities';
import { HealthAccessGuard } from './health-access.guard';
import { HealthController } from './health.controller';
import { JobsController } from './jobs.controller';
import { OPERATIONS_OPTIONS } from './operations.options';
import type { OperationsOptions } from './operations.options';

/**
 * operations — the instance's own operational surface (V2.0 item 3.6 part 2):
 * is it healthy, what has it been doing, and what is it configured to run.
 *
 * Four surfaces, one audience: `/api/health` and the capability registry behind
 * it, `/api/jobs` (the queue's administration view), and `/api/audit` (the
 * append-only trail's paged browse). They answer questions about the *instance*
 * rather than about anyone's memory, which is why none of the domain contexts
 * owns them and why they sat in the composition root until now.
 *
 * It owns no tables. The data belongs to `infrastructure` (the audit trail, the
 * queue ledgers, the migration ledger) and to `memory` and `ingestion` (the
 * sweep and dreaming job states); every read goes through those modules' public
 * interfaces. Registered ONLY in the app root: the worker serves no HTTP, and
 * `CapabilitiesService` is a read surface, not a job.
 */
@Module({})
export class OperationsModule {
  static register(
    options: OperationsOptions & {
      imports?: ModuleMetadata['imports'];
      /**
       * The connector-fleet port's implementation (V2.5 item 8.1, issue A4),
       * mapped onto CONNECTOR_HEALTH by this registration so the capability
       * entry exists only where the root wired the platform in.
       */
      connectorHealth?: Provider;
    },
  ): DynamicModule {
    return {
      module: OperationsModule,
      // The memory module instance (B13 closed): the health report's
      // IntegritySweep + object-store probes resolve from an explicit import.
      imports: [...(options.imports ?? [])],
      controllers: [HealthController, JobsController, AuditController],
      providers: [
        { provide: OPERATIONS_OPTIONS, useValue: options },
        CapabilitiesService,
        // SEC-3: decides who may read the aggregate health report and with how
        // much detail. Applied with @UseGuards inside this module.
        HealthAccessGuard,
        ...(options.connectorHealth ? [options.connectorHealth] : []),
      ],
      // CapabilitiesService is exported for the app entrypoint's boot banner.
      exports: [CapabilitiesService],
    };
  }
}
