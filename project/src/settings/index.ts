/**
 * settings — per-user capture/upload defaults, the user-context surface, and
 * context suggestions (V2.0 item 3.6 part 4, split out of connectors).
 *
 * Public interface: UserSettingsService for the connector families that apply
 * a user's default capture scope; the controllers are HTTP-only surface.
 */
export { SettingsModule } from './settings.module';
/**
 * The slim read port (V2.0 item 3.7): the per-user capture defaults with no
 * dependency but DRIZZLE, for the source readers that stamp a capture's scope
 * and cannot import the full module without closing a cycle back through memory.
 */
export { SettingsPortsModule } from './settings-ports.module';
export { UserSettingsService } from './user-settings.service';
export { CONTEXT_SUGGEST_PROMPT } from './context-suggestions.service';
