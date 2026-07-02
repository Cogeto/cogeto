import { Module } from '@nestjs/common';
import { ModelGateway } from './model-gateway.service';

/**
 * model-gateway — leaf seam for ALL model and embedding calls (§A.10).
 * No direct provider SDK/API usage anywhere else in the system.
 */
@Module({
  providers: [ModelGateway],
  exports: [ModelGateway],
})
export class ModelGatewayModule {}
