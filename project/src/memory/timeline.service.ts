import { Injectable } from '@nestjs/common';
import type { Principal } from '@cogeto/shared';
import {
  computeTimelineDiff,
  laterFateOf,
  type PointInTimeDto,
  type TimelineDto,
  type TimelineDiffDto,
  type TimelineSpan,
} from '@cogeto/shared';
import { MemoryStore } from './memory.store';
import type { MemoryRow } from './persistence/tables';
import { toListItem } from './list-item';
import { intervalHoldsAt, isPastBelief } from './domain/interval';

/** A subject rarely has more than a handful of versions; this is a safe ceiling. */
const SUBJECT_MEMORY_CAP = 200;

/**
 * The time-travel read composition (decision 0012) — the visual surface's thin
 * server half. It invents NO retrieval semantics and touches NO table: every
 * method is a composition over the MemoryStore's own Principal-gated primitives
 * (`listForPrincipal`, `pointInTime`), so the scope and sensitive hard gates
 * hold in every temporal view, at every point in time, exactly as elsewhere
 * (§A.4 gates; decision 0012 ruling 3 "temporal never weakens a hard gate").
 *
 * "Holds at t" is decided ONCE, by `pointInTime`'s shared SQL predicate
 * (ruling 1) — never re-encoded here. This service only shapes the results and
 * applies the past-framing contract (ruling 6), the same one the chat citation
 * chip renders, so the timeline and a temporal chat answer are two views of the
 * one truth.
 */
@Injectable()
export class TimelineService {
  constructor(private readonly store: MemoryStore) {}

  /**
   * A subject's full history as validity spans — every fact mentioning the
   * subject entity, in ANY lifecycle status (the past is the point), gated and
   * ordered newest-effective first. `includeSensitive` returns only the
   * caller's OWN sensitive rows (the store enforces owner-only regardless).
   */
  async forSubject(principal: Principal, subject: string): Promise<TimelineDto> {
    const rows = await this.store.listForSubject(principal, subject, {
      includeSensitive: true,
      limit: SUBJECT_MEMORY_CAP,
    });
    const now = new Date();
    const spans = rows
      .map((row) => this.toSpan(row, now))
      .sort((a, b) => Date.parse(b.effectiveFrom) - Date.parse(a.effectiveFrom));
    return { subject, spans };
  }

  /**
   * The subject as Cogeto understood it at instant `at` — the SAME primitive
   * chat's temporal answer uses (`pointInTime`), narrowed to the subject and
   * intersected with the subject's own facts so the primitive's empty-narrowed
   * recall fallback (memory.store) can never bleed unrelated facts into a
   * subject timeline. Each held fact is labelled with what became of it later.
   */
  async pointInTime(principal: Principal, subject: string, at: Date): Promise<PointInTimeDto> {
    const subjectIds = await this.subjectIds(principal, subject);
    // No entity pre-narrowing here: the subject is identified by `subjectIds`
    // (subject_entity OR entities), so the point-in-time set is the gated facts
    // holding at `at` intersected with that — the interval predicate stays the
    // sole "holds at t" authority, the subject scoping stays consistent with the
    // spans view.
    const hits = await this.store.pointInTime(principal, at, {
      topK: SUBJECT_MEMORY_CAP,
      includeSensitive: true,
    });
    const now = Date.now();
    const facts = hits
      .filter((hit) => subjectIds.has(hit.memory.id))
      .map((hit) => {
        const memory = toListItem(hit.memory);
        return { memory, laterFate: laterFateOf(memory, now), supersededBy: memory.supersededBy };
      });
    return { subject, at: at.toISOString(), facts };
  }

  /**
   * The diff between two instants — two `pointInTime` snapshots run through the
   * pure `computeTimelineDiff` (decision 0012 ruling 4 vocabulary). Because both
   * snapshots go through the same gated primitive, the diff can never surface a
   * fact the point-in-time view or chat would hide.
   */
  async diff(
    principal: Principal,
    subject: string,
    from: Date,
    to: Date,
  ): Promise<TimelineDiffDto> {
    const [atFrom, atTo] = await Promise.all([
      this.pointInTime(principal, subject, from),
      this.pointInTime(principal, subject, to),
    ]);
    return {
      subject,
      from: from.toISOString(),
      to: to.toISOString(),
      ...computeTimelineDiff(
        atFrom.facts.map((f) => f.memory),
        atTo.facts.map((f) => f.memory),
      ),
    };
  }

  /** The gated id set of the subject's facts — the point-in-time narrowing key. */
  private async subjectIds(principal: Principal, subject: string): Promise<Set<string>> {
    const rows = await this.store.listForSubject(principal, subject, {
      includeSensitive: true,
      limit: SUBJECT_MEMORY_CAP,
    });
    return new Set(rows.map((row) => row.id));
  }

  /** Row → span: the interval bounds for display + the past-framing contract. */
  private toSpan(row: MemoryRow, now: Date): TimelineSpan {
    const memory = toListItem(row);
    const past = isPastBelief(row, now);
    return {
      memory,
      effectiveFrom: (row.validFrom ?? row.createdAt).toISOString(),
      effectiveUntil: row.validUntil?.toISOString() ?? null,
      pastBelief: past,
      current: !past && intervalHoldsAt(row, now),
      supersededBy: row.supersededBy,
    };
  }
}
