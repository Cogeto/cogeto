import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { ProviderConfigService } from './provider-config.service';
import { ProvidersController } from './providers.controller';
import { AnswerModelController } from './answer-model.controller';
import { PROVIDERS_OPTIONS } from './providers.options';
import type { ProvidersOptions } from './providers.options';

/**
 * providers — the instance's model and provider configuration (V2.4 item 7.1).
 *
 * Owns six tables (migration 0052) and the two admin surfaces over them. NOT
 * global: the boundary contract's policy allows globality only for
 * infrastructure and seams, and this is a domain module. The app root registers
 * it with controllers; the worker registers it without, because the worker
 * serves no HTTP and only needs the watcher that keeps its configuration
 * current.
 */
@Module({})
export class ProvidersModule {
  static register(
    options: ProvidersOptions & {
      /** The app serves the admin surfaces; the worker registers none. */
      controllers?: boolean;
    },
  ): DynamicModule {
    return {
      module: ProvidersModule,
      controllers: options.controllers ? [ProvidersController, AnswerModelController] : [],
      providers: [{ provide: PROVIDERS_OPTIONS, useValue: options }, ProviderConfigService],
      exports: [ProviderConfigService],
    };
  }
}
