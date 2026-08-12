/**
 * The retrieval lens's one constant (V2.5 item 8.3).
 *
 * The lens is a bounded list of source refs, resolved per turn and handed to
 * retrieval as a VALUE. This cap bounds that list.
 *
 * Above the cap the lens still filters EXACTLY, in Postgres, on both halves of
 * the (source_type, source_id) pair; only the Qdrant payload pre-filter is
 * skipped, so the vector arm over-fetches and the row resolution drops what is
 * out of project. That degrades vector recall inside a very large project and
 * never correctness, and it is never a gate: the scope and sensitive gates run
 * inside every query regardless, unchanged.
 *
 * Stated in docs/features/projects.md rather than hidden, because "the filter
 * silently stopped applying" is the failure this constant exists to avoid.
 */
export const LENS_SOURCE_CAP = 2000;
