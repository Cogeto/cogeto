/**
 * The translation namespaces (V2.0 item 3.5).
 *
 * One namespace per PRODUCT SURFACE, not one file per language: a translator
 * opens `locales/de/review.json` and sees every string the Contradictions page
 * can render, small enough to finish in one sitting. Splitting by surface also
 * keeps a key's meaning readable from its path alone.
 *
 * Adding a namespace means adding it here AND creating the file in EVERY
 * locale — `npm run i18n:check` fails the build otherwise (Issue D).
 */
export const NAMESPACES = [
  /** Words shared by every surface: Save, Cancel, Loading…, relative times. */
  'common',
  /** The left rail and its badges. */
  'navigation',
  /** Login, the demo password gate, the OIDC callback, the demo banner. */
  'auth',
  /** The attention-first dashboard: feed, stats, worker activity, charts. */
  'dashboard',
  /** The conversation surface: composer, citations, capture, conversations. */
  'chat',
  /** Uploads and the source drawer (note, file, email, web page). */
  'sources',
  /** The memory list, its filters, and the memory drawer. */
  'memories',
  /** The Contradictions page (V2.0 item 3.3: contradictions only). */
  'review',
  /** The Forgotten ledger and deletion receipts. */
  'forgotten',
  /** The audit log. */
  'audit',
  /** Settings: capture defaults, profile and context, appearance, models. */
  'settings',
  /** The operator System page: health, jobs, dead letters. */
  'system',
  /** The operator Users page (issue #638): the directory, its honest limits,
   * and erasing a departed person's private material. */
  'users',
  /** Providers and model assignment (V2.4 item 7.1), plus the one model
   * choice a user makes for themselves. */
  'providers',
  /** The capabilities registry and panel. */
  'capabilities',
  /** Consequential actions awaiting a decision. */
  'approvals',
  /** Named skills: runs, plans, steps. */
  'skills',
  /** Web research: the query gate, runs, cited answers. */
  'research',
  /** Time travel. */
  'timeline',
  /** Memory Passport export. */
  'passport',
  /** The findings report (V2.3 item 6.2): trigger, progress, downloads. */
  'reports',
  /** Email capture: inbound address, allowlist, refusals. */
  'email',
  /** The extraction gate: per-connector admission control (V2.1 item 4.3). */
  'extraction',
  /** Connections: the connector fleet and the Confluence door (V2.5 item 8.2). */
  'connections',
  /** Projects as workspaces (V2.5 item 8.3): the rail, assignment, the
   * retrieval lens, and the lifecycle confirmations. */
  'projects',
  /** Failure copy shown to a user. Never developer or log messages. */
  'errors',
  /** One key per server error code (F13). Generated from the throw sites by
   * `npm run i18n:server-errors`; never edited by hand in `en`. */
  'serverErrors',
  /** Field-level validation copy. */
  'validation',
] as const;

export type Namespace = (typeof NAMESPACES)[number];

/** The namespace loaded when a call site does not name one. */
export const DEFAULT_NAMESPACE: Namespace = 'common';
