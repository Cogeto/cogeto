import { Module } from '@nestjs/common';
import type { DynamicModule, ModuleMetadata } from '@nestjs/common';
import { UserContextModule } from '../infrastructure/index';
import { SettingsPortsModule } from './settings-ports.module';
import { SettingsController } from './settings.controller';
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
      // SettingsPortsModule owns the UserSettingsService provider so a process
      // has one instance whether it arrives through here or through the slim
      // port a source reader binds (V2.0 item 3.7).
      imports: [UserContextModule, SettingsPortsModule, ...(options.imports ?? [])],
      controllers: [SettingsController, UserContextController],
      providers: [ContextSuggestionsService],
      // The MODULE is re-exported, not the provider: Nest refuses to export a
      // provider a module neither declares nor owns, and SettingsPortsModule is
      // where UserSettingsService is declared now. A consumer that imports
      // SettingsModule still resolves UserSettingsService, transitively.
      exports: [SettingsPortsModule],
    };
  }
}
