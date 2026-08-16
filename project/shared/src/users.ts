/**
 * The administrative Users surface (issue #638).
 *
 * One row per person the instance has seen, and what an erasure would do to
 * their material. Everything here is administrative: the route behind it
 * requires the operator role.
 *
 * ## Why nothing here names a source
 *
 * The mockup for this page listed sources by title ("my 1:1 notes with
 * Marko…"). Those titles are CONTENT: a note's name is its first line, and a
 * conversation's title is written from what the person typed. Showing them
 * would hand one administrator the subject lines of another person's private
 * material, which no route in the product does today and which the erasure
 * API deliberately does not do either.
 *
 * Counts by kind answer the question the screen exists to answer — how much
 * goes, how much stays, and why — without that disclosure. An administrator
 * erasing a departed colleague is not choosing between sources; the act is
 * all-or-nothing per person.
 */

/** How many sources of one kind an erasure would touch. */
export interface ErasureCountDto {
  /** A registered source type: `user_note`, `file`, `email`, `web`, … */
  sourceType: string;
  count: number;
}

/** One person in the directory, with what an erasure would act on. */
export interface AdminUserDto {
  userId: string;
  displayName: string;
  email: string | null;
  /** ISO-8601. First recorded, i.e. their first sign-in. */
  firstSeen: string;
  /** ISO-8601. Their most recent sign-in. */
  lastSeen: string;
  /** Private sources an erasure would attempt. */
  erasableSources: number;
  /** Sources it would keep because they are shared. */
  sharedSources: number;
  /** True for the caller's own row: the page offers no action on it. */
  isSelf: boolean;
}

export interface AdminUsersDto {
  users: AdminUserDto[];
}

/**
 * What an erasure would do. The counts are exact for sources; `kept` covers
 * only sources whose OWN scope is shared, because whether a private source
 * holds a shared fact cannot be known without enumerating every derived
 * memory. The completed run reports those separately.
 */
export interface ErasurePreviewDto {
  subjectUserId: string;
  displayName: string;
  email: string | null;
  toErase: ErasureCountDto[];
  kept: ErasureCountDto[];
  toEraseTotal: number;
  keptTotal: number;
}

/** What an erasure DID, once the worker settled. */
export interface ErasureResultDto {
  subjectUserId: string;
  erased: number;
  receipts: number;
  kept: number;
  /** Kept because a fact derived from the source is shared. */
  keptForSharedFact: number;
  failed: number;
  /** Still running: the worker has not written its completion entry yet. */
  pending: boolean;
}
