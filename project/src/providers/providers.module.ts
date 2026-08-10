import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
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
      /**
       * The root's memory module instance (V2.4 item 7.1 second half): the
       * managed embedding rebuild is memory's engine, and the admin flow here
       * drives it through memory's exported EmbeddingRebuildService. Optional:
       * the worker root and harnesses register without it, and the embeddings
       * tier then reports itself locked with the operator command.
       */
      imports?: ModuleMetadata['imports'];
    },
  ): DynamicModule {
    return {
      module: ProvidersModule,
      imports: options.imports ?? [],
      controllers: options.controllers ? [ProvidersController, AnswerModelController] : [],
      providers: [{ provide: PROVIDERS_OPTIONS, useValue: options }, ProviderConfigService],
      exports: [ProviderConfigService],
    };
  }
}
