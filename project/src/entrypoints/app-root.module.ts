import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/index';
import { MemoryModule } from '../memory/index';
import { RetrievalModule } from '../retrieval/index';
import { AgentsModule } from '../agents/index';
import { ConnectorsModule } from '../connectors/index';
import { TasksModule } from '../tasks/index';
import { ModelGatewayModule } from '../model-gateway/index';
import { COGETO_CONFIG } from './config';
import type { CogetoConfig } from './config';
import { HealthController } from './health.controller';
import { WebConfigController } from './web-config.controller';

/**
 * Composition root of the app process (fast path only: API, dashboard,
 * connectors' HTTP surface, approval endpoints). Declarative wiring only —
 * "initialize everything inline" erosion is the known failure mode
 * (research: project-structure-lessons §1).
 */
export function createAppRootModule(config: CogetoConfig): unknown {
  @Module({
    imports: [
      IdentityModule.register({
        internalBaseUrl: config.oidc.internalUrl,
        externalDomain: config.oidc.externalDomain,
        cacheTtlSeconds: 60,
      }),
      ModelGatewayModule,
      MemoryModule,
      RetrievalModule,
      AgentsModule,
      ConnectorsModule,
      TasksModule,
    ],
    controllers: [HealthController, WebConfigController],
    providers: [{ provide: COGETO_CONFIG, useValue: config }],
  })
  class AppRootModule {}

  return AppRootModule;
}
