/**
 * The source-type registry (spec §15.3; V2.0 item 3.6 part 3, closing B16).
 *
 * A source type is registered here, once, with every cross-cutting property a
 * consumer needs — it is no longer enumerated in a database type. The
 * `memory.source_type` and `deletion_receipt.source_type` columns are plain
 * text since migration 0040; this table is what validates a value at the
 * boundaries and what replaces every per-type switch with a metadata read.
 *
 * Adding a source type is: one entry here, a SourceReader and a SourceDeletion
 * adapter in the owning connector module, and the composition-root bindings.
 * No migration, and no edit inside the memory module. The TypeScript union
 * below stays closed, so every per-surface Record typed over it fails to
 * COMPILE until the new type's treatment is decided there — a missed site is
 * a build error, never a silent per-type fallback.
 *
 * This deliberately contrasts with `uncertainty_reason` (migration 0039),
 * which stays a Postgres enum because that vocabulary is FROZEN by design.
 * Source types are the opposite: an open vocabulary that the connector
 * platform (V2 item 8.1) extends, which is exactly why the spec forbids
 * enumerating them in the database.
 */

export interface SourceTypeDescriptor {
  /**
   * No live producer. A defunct value is a KNOWN value, never an unexpected
   * one (AGENTS.md): nothing writes it, no switch may throw on it, and the
   * integrity sweep's defunct arm proves it has no surviving rows.
   */
  defunct: boolean;
  /**
   * The first-person-rule contract: whose words does this source carry?
   * `always`/`never` sources declare `authoredByUser` statically in their
   * reader; `per_item` sources (email) compute it per message from routing and
   * forwarding. `none` = the type never produces memories at all, so
   * authorship does not arise. Open loops read only `authored_by_user = true`
   * rows (MemoryStore.openLoopsForPrincipal), so this field is what keeps a
   * document's obligations from becoming the user's.
   */
  userAuthored: 'always' | 'never' | 'per_item' | 'none';
  /**
   * The source row IS a memory-owned `file_metadata` row keyed by object key,
   * with original bytes in the object store. Drives the deletion saga's
   * file leg (metadata + object erased in-module, no adapter, discard-mode
   * runs waited out), the passport's original-bytes resolution, and the
   * sweep's receipt-side-only orphan detection for this type. Every other
   * type resolves through its module's SourceDeletion adapter.
   */
  objectBacked: boolean;
  /**
   * Extraction applies: the pipeline has a SourceReader for this type and its
   * captures enqueue `ingestion.pipeline`. False for container types
   * (`chat_conversation` exists for deletion receipts only — a conversation's
   * memories cite their messages) and for defunct types.
   */
  extraction: boolean;
  /**
   * Per-type cap on extracted facts per run, null = the deployment's
   * `parseCaps.maxFacts`. Reference material (web) contributes its salient
   * facts, never the worst-case hundred; first-person sources keep the full
   * cap.
   */
  factBudget: number | null;
  /**
   * The label used when a fact's provenance is rendered INSIDE a model prompt
   * (answer citations, context suggestions). Prompt input, not user-visible
   * copy — the SPA translates display names per surface through value → key
   * maps, never from here.
   */
  promptLabel: string;
  /**
   * Which family the attention dashboard's sources chart counts this type
   * under; null = excluded (web fetches and container/defunct types are not
   * user-ingested capture activity).
   */
  dashboardFamily: 'notes' | 'email' | 'files' | null;
}

/**
 * The registry. Keys are the stored `source_type` values — byte-identical to
 * the retired enum's members, so every historical deletion receipt hashes and
 * verifies unchanged.
 */
export const SOURCE_TYPES = {
  user_note: {
    defunct: false,
    userAuthored: 'always',
    objectBacked: false,
    extraction: true,
    factBudget: null,
    promptLabel: 'note',
    dashboardFamily: 'notes',
  },
  chat: {
    defunct: false,
    userAuthored: 'always',
    objectBacked: false,
    extraction: true,
    factBudget: null,
    promptLabel: 'chat',
    dashboardFamily: 'notes',
  },
  email: {
    defunct: false,
    userAuthored: 'per_item',
    objectBacked: false,
    extraction: true,
    factBudget: null,
    promptLabel: 'email',
    dashboardFamily: 'email',
  },
  calendar_event: {
    // Defunct: calendar left the roadmap before v1; the value predates that.
    defunct: true,
    userAuthored: 'none',
    objectBacked: false,
    extraction: false,
    factBudget: null,
    promptLabel: 'calendar event',
    dashboardFamily: null,
  },
  file: {
    defunct: false,
    userAuthored: 'never',
    objectBacked: true,
    extraction: true,
    factBudget: null,
    promptLabel: 'file',
    dashboardFamily: 'files',
  },
  task_conclusion: {
    // Defunct: the task subsystem was removed (V2.0 items 3.1/3.2) and
    // migration 0035 dropped its table after erasing every memory that
    // pointed at it. The value stays registered forever: receipts citing it
    // must keep verifying, and the 1.x upgrade CLI
    // (erase-task-conclusions.ts) still names it.
    defunct: true,
    userAuthored: 'none',
    objectBacked: false,
    extraction: false,
    factBudget: null,
    promptLabel: 'task conclusion',
    dashboardFamily: null,
  },
  web: {
    defunct: false,
    userAuthored: 'never',
    objectBacked: false,
    extraction: true,
    // A fetched page is reference material — salient facts, never the
    // worst-case hundred; also bounds the verify/reconcile/embed fan-out.
    factBudget: 30,
    promptLabel: 'web',
    dashboardFamily: null,
  },
  chat_conversation: {
    // A whole conversation: exists for deletion receipts and the saga
    // adapter only. No memory ever carries this value — chat memories cite
    // their message ('chat').
    defunct: false,
    userAuthored: 'none',
    objectBacked: false,
    extraction: false,
    factBudget: null,
    promptLabel: 'chat conversation',
    dashboardFamily: null,
  },
} as const satisfies Record<string, SourceTypeDescriptor>;

/** The closed union internal producers are typed with. */
export type SourceTypeKey = keyof typeof SOURCE_TYPES;

export const SOURCE_TYPE_KEYS = Object.keys(SOURCE_TYPES) as SourceTypeKey[];

/**
 * Source types the product no longer produces. Derived, never a second list.
 * The contract for every reader: a defunct value is KNOWN, not unexpected. No
 * switch may throw on it, no sweep arm may flag it as unrecognised. It should
 * simply have no rows — and after migration 0035 it provably has none, since
 * that migration refuses to run while any survive.
 */
export const DEFUNCT_SOURCE_TYPES = SOURCE_TYPE_KEYS.filter((key) => SOURCE_TYPES[key].defunct);

export function isRegisteredSourceType(value: string): value is SourceTypeKey {
  return Object.prototype.hasOwnProperty.call(SOURCE_TYPES, value);
}

/** The descriptor, or null for a value the registry does not know. */
export function sourceTypeDescriptor(value: string): SourceTypeDescriptor | null {
  return isRegisteredSourceType(value) ? SOURCE_TYPES[value] : null;
}

/**
 * The prompt-input label for any stored value, registered or not. The
 * fallback mirrors what every consumer did before the registry existed
 * (`replace('_', ' ')`), so an unknown value renders verbatim instead of
 * throwing.
 */
export function sourceTypePromptLabel(value: string): string {
  return sourceTypeDescriptor(value)?.promptLabel ?? value.replace(/_/g, ' ');
}
