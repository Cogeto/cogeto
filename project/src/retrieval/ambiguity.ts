import type { AmbiguityClusterDto, AmbiguityDecisionDto } from '@cogeto/shared';
import type { AmbiguityThresholds } from './ambiguity-config';
import { MAX_FANOUT_LINES } from './ambiguity-config';

/**
 * Ambiguity detection (V2.3 item 6.3, spec §7.5): deterministic arithmetic
 * over the post-fusion score distribution across anchored-entity clusters.
 * Pure and container-free so the decision rule is unit-testable exhaustively
 * without the rest of the stack; no model is ever asked whether a question is
 * ambiguous. Design and the reasoning behind every rule:
 * docs/features/ambiguity.md.
 */

/** What the clustering needs from one post-fusion hit. */
export interface AmbiguityHit {
  memoryId: string;
  /** The anchored subject entity (4.2); null on pre-anchoring rows. */
  subjectEntity: string | null;
  /** The fact's entity list — the fallback signal when anchoring is absent. */
  entities: readonly string[];
  /** The fact's claim text, for the identity lift's containment check: an
   * extracted entity list can miss a name the claim plainly carries ("Marko
   * owes the list before the Adriatic Foods workshop" stores entities
   * ["Marko"]), and the keyword signal that surfaced the fact matched the
   * content, not the list. Null-safe; never used for anything but the lift. */
  content: string | null;
  /** Fused score (RRF × status multiplier). */
  fusedScore: number;
  /** Normalized [0,1] vector similarity; null when the vector signal did not
   * surface this hit. */
  vectorScore: number | null;
}

/**
 * Alias-canonical folded key for an entity name. The retrieval service binds
 * this to the owner's EntityAliasIndex (fold + recorded aliases); tests bind
 * plain folds. Keeping it a function keeps this module pure.
 */
export type EntityKeyOf = (name: string) => string;

export interface AmbiguityCluster {
  /** Alias-canonical folded key; '' for the unanchored bucket. */
  key: string;
  /** Display subject: the top-fused member's own subject entity; '' unanchored. */
  subject: string;
  /** Best member vector similarity; 0 when never vector-surfaced. */
  relevance: number;
  /** Max member fused score — best evidence, never volume (see the record). */
  fused: number;
  /**
   * A member's subject or entities fold-match an entity the QUESTION names.
   * Identity evidence: it lifts the cluster over the relevance floor
   * (the exact reasoning the reconcile config records for its alias
   * exemption — the identity is the evidence the similarity band was a
   * proxy for), because the gap between a related fact about an adjacent
   * subject and an unrelated one can be smaller than the floor can split.
   */
  entityNamed: boolean;
  memberIds: string[];
  topMemoryId: string;
}

/**
 * Group post-fusion hits into candidate answer subjects:
 *
 * 1. A hit with an anchored subject joins (or founds) the cluster of that
 *    subject's alias-canonical folded key.
 * 2. A hit WITHOUT one founds (or joins) a nameable cluster under an entity
 *    the QUESTION itself names, when one of its folded entities matches a
 *    query entity: the entity identity is the evidence anchoring would have
 *    provided, and this is what keeps a legacy pre-anchoring corpus
 *    answering entity-named questions exactly as before.
 * 3. Otherwise it attaches to an already-founded cluster when one of its
 *    folded entities equals that cluster's key — processed after every
 *    anchored hit so attachment is order-independent.
 * 4. What remains pools into the single unanchored bucket (key ''), which is
 *    never a fan-out candidate: a line that cannot name its subject cannot
 *    ask "did you mean this one?".
 *
 * An anchorless hit never BRIDGES two subjects (it founds or attaches by its
 * own entities to at most one cluster): bridging would collapse genuine
 * ambiguity, which is the silent-guess direction.
 */
export function clusterBySubject(
  hits: readonly AmbiguityHit[],
  keyOf: EntityKeyOf,
  queryEntities: readonly string[] = [],
): AmbiguityCluster[] {
  interface Building {
    key: string;
    subject: string;
    relevance: number;
    fused: number;
    entityNamed: boolean;
    memberIds: string[];
    topMemoryId: string;
  }
  const clusters = new Map<string, Building>();
  const queryKeys = new Set(queryEntities.map((e) => keyOf(e)).filter((k) => k.length > 0));
  // The identity lift matches on token-boundary CONTAINMENT of a query-named
  // name inside the fact's names ("Adriatic Foods" names "Adriatic Foods
  // workshop") and inside the fact's claim text (an extracted entity list can
  // miss a name the claim plainly carries; the keyword signal that surfaced
  // the fact matched the content). Both sides go through the alias-canonical
  // keyOf, which for a multi-word text degrades to the plain fold, so a
  // content-only match through a RECORDED ALIAS is not lifted; the
  // alias-aware subject and entity checks are the alias path. The
  // containment direction is fixed, query name inside the fact's text,
  // never the reverse, so a short fact entity cannot claim a longer query
  // name.
  const paddedQueryKeys = [...queryKeys].map((k) => ` ${k} `);
  const containsQueryName = (text: string | null | undefined): boolean => {
    if (!text || paddedQueryKeys.length === 0) return false;
    const folded = ` ${keyOf(text)} `;
    if (folded.trim().length === 0) return false;
    return paddedQueryKeys.some((needle) => folded.includes(needle));
  };
  const hitIsNamed = (hit: AmbiguityHit): boolean =>
    containsQueryName(hit.subjectEntity) ||
    hit.entities.some((entity) => containsQueryName(entity)) ||
    containsQueryName(hit.content);

  const join = (cluster: Building, hit: AmbiguityHit) => {
    cluster.memberIds.push(hit.memoryId);
    cluster.relevance = Math.max(cluster.relevance, hit.vectorScore ?? 0);
    cluster.entityNamed = cluster.entityNamed || hitIsNamed(hit);
    if (hit.fusedScore > cluster.fused) {
      cluster.fused = hit.fusedScore;
      cluster.topMemoryId = hit.memoryId;
      if (hit.subjectEntity) cluster.subject = hit.subjectEntity;
    }
  };

  const anchored: AmbiguityHit[] = [];
  const anchorless: AmbiguityHit[] = [];
  for (const hit of hits) {
    (hit.subjectEntity && keyOf(hit.subjectEntity) ? anchored : anchorless).push(hit);
  }

  for (const hit of anchored) {
    const key = keyOf(hit.subjectEntity!);
    const existing = clusters.get(key);
    if (existing) {
      join(existing, hit);
    } else {
      clusters.set(key, {
        key,
        subject: hit.subjectEntity!,
        relevance: hit.vectorScore ?? 0,
        fused: hit.fusedScore,
        entityNamed: hitIsNamed(hit),
        memberIds: [hit.memoryId],
        topMemoryId: hit.memoryId,
      });
    }
  }

  const unanchored: AmbiguityHit[] = [];
  for (const hit of anchorless) {
    // Query-named entity first (rule 2): the question's own naming outranks
    // a guessy attachment to whatever anchored cluster shares an entity.
    const named = hit.entities.find((entity) => queryKeys.has(keyOf(entity)));
    if (named !== undefined) {
      const key = keyOf(named);
      const existing = clusters.get(key);
      if (existing) {
        join(existing, hit);
      } else {
        clusters.set(key, {
          key,
          subject: named,
          relevance: hit.vectorScore ?? 0,
          fused: hit.fusedScore,
          entityNamed: true,
          memberIds: [hit.memoryId],
          topMemoryId: hit.memoryId,
        });
      }
      continue;
    }
    // Attach to the strongest founded cluster one of this hit's entities
    // names; deterministic because candidate clusters are compared by
    // (fused desc, key asc) before the hit joins and can change them.
    let target: Building | undefined;
    for (const entity of hit.entities) {
      const found = clusters.get(keyOf(entity));
      if (!found) continue;
      if (
        !target ||
        found.fused > target.fused ||
        (found.fused === target.fused && found.key < target.key)
      ) {
        target = found;
      }
    }
    if (target) join(target, hit);
    else unanchored.push(hit);
  }

  if (unanchored.length > 0) {
    const bucket: Building = {
      key: '',
      subject: '',
      relevance: 0,
      fused: 0,
      entityNamed: false,
      memberIds: [],
      topMemoryId: unanchored[0]!.memoryId,
    };
    // Seed so the first join keeps topMemoryId consistent with max fused.
    bucket.fused = -1;
    for (const hit of unanchored) join(bucket, hit);
    clusters.set('', bucket);
  }

  return [...clusters.values()].sort((a, b) => b.fused - a.fused || a.key.localeCompare(b.key));
}

/**
 * The decision rule (spec §7.5), evaluated in order — see
 * docs/features/ambiguity.md for why each rule exists:
 *
 * 1. NAMED SUBJECT WINS. A question that names a cluster's subject (alias
 *    aware) is not ambiguous; naming several is a comparison the normal
 *    answer path already handles. This is also how a fan-out's follow-up
 *    resolves without re-fanning.
 * 2. RELEVANCE FLOOR. No cluster at or above it: the corpus is silent.
 * 3. COMPARABILITY. Among nameable survivors, every cluster whose fused
 *    score is at least ratio × the top nameable fused score is a candidate.
 *    One candidate: dominant. Several: fan out, score order, capped with the
 *    cap stated. The unanchored bucket counts for the floor (its relevance is
 *    real) but never fans out, and when it out-scores every nameable cluster
 *    the best evidence cannot be disambiguated, so the answer path proceeds
 *    normally.
 */
export function decideAmbiguity(
  clusters: readonly AmbiguityCluster[],
  queryEntities: readonly string[],
  keyOf: EntityKeyOf,
  thresholds: AmbiguityThresholds,
  meta: { configVersion: number; embeddingModel: string; queryText?: string },
  maxLines: number = MAX_FANOUT_LINES,
): AmbiguityDecisionDto {
  const record = (
    branch: AmbiguityDecisionDto['branch'],
    named: string[],
    shown: Set<string>,
    capped: boolean,
  ) => ({
    branch,
    clusters: clusters.map((c): AmbiguityClusterDto => ({
      subject: c.subject,
      key: c.key,
      relevance: round(c.relevance),
      fused: round(c.fused),
      entityNamed: c.entityNamed,
      size: c.memberIds.length,
      topMemoryId: c.topMemoryId,
      shown: shown.has(c.key),
    })),
    named,
    capped,
    configVersion: meta.configVersion,
    embeddingModel: meta.embeddingModel,
  });

  const none = new Set<string>();

  // 1. Named subject wins — split by WHAT the query name matches, because
  // the three shapes mean three different things:
  //
  // 1a. EXACT subject match (alias-aware): deliberate naming. One subject is
  //     the fragment/follow-up resolution; several is a comparison the
  //     normal answer path already handles. Dominant.
  // 1b. PARTIAL subject match ("Ana" against "Ana Kovač", either direction
  //     on token boundaries): unique means the short name resolves to the
  //     one subject carrying it, dominant. SEVERAL subjects sharing the
  //     queried name is precisely the two-Anas ambiguity, and it fans out
  //     over exactly those subjects — the shared name is identity evidence
  //     per cluster, so the relevance floor does not apply to this set.
  // 1c. TOPIC match (the name appears in members' entities or claims but in
  //     no subject): an aggregation question about something the clusters'
  //     facts share — "the full scope of the Atlas CRM migration" — and a
  //     fan-out over the subjects that discuss it would interrogate the
  //     user about a distinction they did not ask about. Dominant. The
  //     live gate caught exactly this shape regressing.
  const namedKeys = new Set(queryEntities.map((e) => keyOf(e)).filter((k) => k.length > 0));
  const paddedNamedKeys = [...namedKeys].map((k) => ` ${k} `);
  const partiallyNamed = (clusterKey: string): boolean => {
    const padded = ` ${clusterKey} `;
    return paddedNamedKeys.some(
      (queryKey) => padded.includes(queryKey) || queryKey.includes(padded),
    );
  };

  // RAW-TEXT naming (issue #497). The keys above come from the rewrite's
  // entity extraction, and the recorded decisions from a real corpus showed
  // it returning NOTHING for follow-up phrasings ("I meant nexen europe
  // group bv", "…for beckhoff") while the named subject sat on screen — the
  // user was answering the fan-out and got the same fan-out back. So the
  // query TEXT itself also names: a cluster whose alias-canonical key
  // appears token-bounded inside the folded query is exactly-named, and a
  // cluster one of whose key tokens (four characters or longer, so "d",
  // "group" and unit words cannot claim it alone… length keeps initials and
  // legal-suffix noise out) appears as a query token is partially-named.
  // Both are deterministic string checks; several partial matches fan out
  // over exactly those clusters, the existing two-Anas rule.
  const foldedQuery = meta.queryText ? ` ${keyOf(meta.queryText)} ` : '';
  const rawExactNamed = (clusterKey: string): boolean =>
    foldedQuery.trim().length > 0 && foldedQuery.includes(` ${clusterKey} `);
  const rawPartiallyNamed = (clusterKey: string): boolean =>
    foldedQuery.trim().length > 0 &&
    clusterKey.split(' ').some((token) => token.length >= 4 && foldedQuery.includes(` ${token} `));

  const exactNamed = clusters.filter(
    (c) => c.key !== '' && (namedKeys.has(c.key) || rawExactNamed(c.key)),
  );
  if (exactNamed.length > 0) {
    return record(
      'dominant',
      exactNamed.map((c) => c.key),
      none,
      false,
    );
  }
  const partialNamed = clusters.filter(
    (c) => c.key !== '' && (partiallyNamed(c.key) || rawPartiallyNamed(c.key)),
  );
  if (partialNamed.length === 1) {
    return record('dominant', [partialNamed[0]!.key], none, false);
  }
  if (partialNamed.length > 1) {
    const candidates = [...partialNamed].sort(
      (a, b) => b.fused - a.fused || a.key.localeCompare(b.key),
    );
    const shown = new Set(candidates.slice(0, maxLines).map((c) => c.key));
    return record('fan_out', [], shown, candidates.length > maxLines);
  }
  const topicNamed = clusters.filter((c) => c.key !== '' && c.entityNamed);
  if (topicNamed.length > 0) {
    return record(
      'dominant',
      topicNamed.map((c) => c.key),
      none,
      false,
    );
  }

  // 2. Relevance floor — with the identity lift: a cluster a query-named
  // entity appears in is relevant whatever its similarity (the gap between a
  // related fact about an adjacent subject and an unrelated fact can be
  // smaller than any floor can split; the identity is the evidence the band
  // was a proxy for). The unanchored bucket counts too: its relevance is
  // real, and claiming silence over it would be false.
  const relevant = clusters.filter(
    (c) => c.entityNamed || c.relevance >= thresholds.relevanceFloor,
  );
  if (relevant.length === 0) {
    // A floor that was never measured under THIS embedding model may not
    // declare the corpus empty (issue #477). An absolute similarity is vector
    // space geometry, so a borrowed floor is a number about a different space:
    // under bge-m3 a relevant cluster measured 0.8191 against a floor of 0.90
    // borrowed from mistral-embed, and the product answered "I have nothing
    // about this in your sources" while holding fifteen matching facts.
    //
    // With clusters present and no measured floor to judge them by, the honest
    // branch is `dominant`: hand the retrieved facts to the answer path, which
    // cites what it uses and can say the records do not settle the question.
    // Silence stays reachable and stays honest, from the case below: retrieval
    // returned nothing at all.
    if (!thresholds.calibrated && clusters.length > 0) {
      return record('dominant', [], none, false);
    }
    return record('silent', [], none, false);
  }

  // 3. Comparability over the nameable survivors.
  const nameable = relevant.filter((c) => c.key !== '');
  if (nameable.length === 0) return record('dominant', [], none, false);
  const topNameable = nameable.reduce((a, b) => (b.fused > a.fused ? b : a));
  const unanchoredTop = relevant.find((c) => c.key === '');
  if (unanchoredTop && unanchoredTop.fused > topNameable.fused) {
    return record('dominant', [], none, false);
  }
  // The epsilon keeps the calibrated boundary itself inside "comparable":
  // ratio × top is a float product, and a cluster sitting exactly on the
  // published cut point must not fall out over the fifteenth decimal (the
  // same knife-edge rule the gate model records for floors).
  const candidates = nameable
    .filter((c) => c.fused + 1e-12 >= thresholds.comparabilityRatio * topNameable.fused)
    .sort((a, b) => b.fused - a.fused || a.key.localeCompare(b.key));
  if (candidates.length === 1) return record('dominant', [], none, false);

  const shown = new Set(candidates.slice(0, maxLines).map((c) => c.key));
  return record('fan_out', [], shown, candidates.length > maxLines);
}

/** Stored-record precision: four decimals keeps jsonb readable and diffable. */
function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
