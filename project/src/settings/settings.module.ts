import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { UserContextModule } from '../infrastructure/index';
import { SettingsController } from './settings.controller';
import { UserSettingsService } from './user-settings.service';
import { UserContextController } from './user-context.controller';
import { ContextSuggestionsService } from './context-suggestions.service';

/**
 * settings — the user's own knobs (V2.0 item 3.6 part 4, split out of the
 * connectors context): per-user capture/upload defaults (`user_settings`),
 * the user-context surface (the record itself is infrastructure's), and the
 * derived context suggestions. NOT global: every consumer imports this module
 * explicitly, per the boundary contract's policy.
 */
@Module({})
export class SettingsModule {
  static register(options: { imports?: ModuleMetadata['imports'] } = {}): DynamicModule {
    return {
      module: SettingsModule,
      imports: [UserContextModule, ...(options.imports ?? [])],
      controllers: [SettingsController, UserContextController],
      providers: [UserSettingsService, ContextSuggestionsService],
      exports: [UserSettingsService],
    };
  }
}
