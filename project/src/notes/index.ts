/**
 * notes — typed-note capture (V2.0 item 3.6 part 4, split out of connectors).
 *
 * Public interface: the module, the service, and the two port adapters the
 * composition roots bind into ingestion (reader) and memory (deletion).
 */
export { NotesModule } from './notes.module';
export { NotesService } from './notes.service';
export { NotesSourceReader } from './notes.source-reader';
export { NotesSourceDeletion } from './notes.source-deletion';
export { NotesSourcePortsModule } from './notes-source-ports.module';

// The source catalog's note listing (V2.2 item 5.2): plain owner-scoped
// functions, the `latestGateRefusalFor` shape.
export { listNoteSources, hydrateNoteSources, countNoteSources } from './source-listing';
