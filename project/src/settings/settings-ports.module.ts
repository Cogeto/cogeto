import { Module } from '@nestjs/common';
import { UserSettingsService } from './user-settings.service';

/**
 * The settings family's read PORT as a slim standalone module (V2.0 item 3.7,
 * the `NotesSourcePortsModule` shape): the per-user capture defaults, whose only
 * dependency is the global DRIZZLE handle.
 *
 * It exists because a source reader needs the owner's default capture scope
 * (chat capture, V2.0 item 3.7) while living inside `ChatSourceModule`, which
 * the memory module imports through its registration options. Importing the
 * full `SettingsModule` there would close the loop
 * memory → chat ports → settings → memory, which is the cycle the slim
 * source-ports modules were invented to avoid. This module imports nothing, so
 * it cannot participate in one.
 *
 * `SettingsModule` imports it and re-exports the service, so a process has ONE
 * instance no matter how many places bind the port.
 */
@Module({
  providers: [UserSettingsService],
  exports: [UserSettingsService],
})
export class SettingsPortsModule {}
