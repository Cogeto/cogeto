/**
 * settings — per-user capture/upload defaults, the user-context surface, and
 * context suggestions (V2.0 item 3.6 part 4, split out of connectors).
 *
 * Public interface: UserSettingsService for the connector families that apply
 * a user's default capture scope; the controllers are HTTP-only surface.
 */
export { SettingsModule } from './settings.module';
export { UserSettingsService } from './user-settings.service';
export type { UserSettingsRow } from './persistence/tables';
export { CONTEXT_SUGGEST_PROMPT } from './context-suggestions.service';
