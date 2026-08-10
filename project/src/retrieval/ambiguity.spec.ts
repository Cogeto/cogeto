import { describe, expect, it } from 'vitest';
import { clusterBySubject, decideAmbiguity } from './ambiguity';
import type { AmbiguityCluster, AmbiguityHit } from './ambiguity';
import { AMBIGUITY_CONFIG_VERSION, ambiguityThresholdsFor } from './ambiguity-config';

/**
 * The spec §7.5 decision rule, exhaustively and without the stack: the inputs
 * are the score distribution, the output is the branch plus the clusters
 * involved (V2.3 item 6.3, issue A). The alias mechanism is injected as a
 * plain function, so these tests stand without ingestion.
 */

const fold = (name: string) => name.trim().toLowerCase();
/** An alias-aware keyOf: VX-9 Housing and VX-9 are one recorded identity. */
const aliased = (name: string) => {
  const folded = fold(name);
  return folded === 'vx-9 housing' ? 'vx-9' : folded;
};

const THRESHOLDS = { relevanceFloor: 0.9, comparabilityRatio: 0.55, calibrated: true };
/** A model whose floor was borrowed rather than measured (issue #477). */
const UNCALIBRATED = { relevanceFloor: 0.9, comparabilityRatio: 0.55, calibrated: false };
const META = { configVersion: AMBIGUITY_CONFIG_VERSION, embeddingModel: 'test-embed' };

let nextId = 0;
function hit(over: Partial<AmbiguityHit> = {}): AmbiguityHit {
  nextId += 1;
  return {
    memoryId: `m-${String(nextId).padStart(3, '0')}`,
    subjectEntity: null,
    entities: [],
    content: null,
    fusedScore: 0.02,
    vectorScore: null,
    ...over,
  };
}

function cluster(over: Partial<AmbiguityCluster> = {}): AmbiguityCluster {
  return {
    key: 'vx-9',
    subject: 'VX-9',
    relevance: 0.95,
    entityNamed: false,
    fused: 0.03,
    memberIds: ['m-001'],
    topMemoryId: 'm-001',
    ...over,
  };
}

describe('clusterBySubject', () => {
  it('groups hits by the alias-canonical folded subject', () => {
    const clusters = clusterBySubject(
      [
        hit({ subjectEntity: 'VX-9', fusedScore: 0.03, vectorScore: 0.8 }),
        hit({ subjectEntity: 'vx-9', fusedScore: 0.02, vectorScore: 0.7 }),
        hit({ subjectEntity: 'SEN-210', fusedScore: 0.025, vectorScore: 0.75 }),
      ],
      fold,
    );
    expect(clusters.map((c) => c.key)).toEqual(['vx-9', 'sen-210']);
    expect(clusters[0]!.memberIds).toHaveLength(2);
  });

  it('merges alias-equivalent subjects into one cluster', () => {
    const clusters = clusterBySubject(
      [
        hit({ subjectEntity: 'VX-9', fusedScore: 0.03 }),
        hit({ subjectEntity: 'VX-9 Housing', fusedScore: 0.02 }),
      ],
      aliased,
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.key).toBe('vx-9');
  });

  it('displays the top-fused member subject in its original casing', () => {
    const clusters = clusterBySubject(
      [
        hit({ subjectEntity: 'vx-9', fusedScore: 0.01 }),
        hit({ subjectEntity: 'VX-9', fusedScore: 0.04 }),
      ],
      fold,
    );
    expect(clusters[0]!.subject).toBe('VX-9');
    expect(clusters[0]!.topMemoryId).toBe(clusters[0]!.memberIds[1]);
  });

  it('scores relevance as the best member vector similarity, absent as 0', () => {
    const clusters = clusterBySubject(
      [
        hit({ subjectEntity: 'VX-9', vectorScore: null }),
        hit({ subjectEntity: 'VX-9', vectorScore: 0.71 }),
        hit({ subjectEntity: 'SEN-210', vectorScore: null }),
      ],
      fold,
    );
    expect(clusters.find((c) => c.key === 'vx-9')!.relevance).toBe(0.71);
    expect(clusters.find((c) => c.key === 'sen-210')!.relevance).toBe(0);
  });

  it('scores a cluster by its best member, never by volume', () => {
    const clusters = clusterBySubject(
      [
        hit({ subjectEntity: 'Weak', fusedScore: 0.015 }),
        hit({ subjectEntity: 'Weak', fusedScore: 0.015 }),
        hit({ subjectEntity: 'Weak', fusedScore: 0.015 }),
        hit({ subjectEntity: 'Strong', fusedScore: 0.03 }),
      ],
      fold,
    );
    expect(clusters[0]!.key).toBe('strong');
    expect(clusters[0]!.fused).toBe(0.03);
    expect(clusters[1]!.fused).toBe(0.015); // never 3 × 0.015
  });

  it('attaches an anchorless hit to the strongest cluster one of its entities names', () => {
    const clusters = clusterBySubject(
      [
        hit({ subjectEntity: 'VX-9', fusedScore: 0.03 }),
        hit({ subjectEntity: 'SEN-210', fusedScore: 0.02 }),
        hit({ entities: ['SEN-210', 'VX-9'], fusedScore: 0.01, vectorScore: 0.9 }),
      ],
      fold,
    );
    // Both entities match; the stronger cluster (VX-9) wins the attachment.
    expect(clusters.find((c) => c.key === 'vx-9')!.memberIds).toHaveLength(2);
    expect(clusters.find((c) => c.key === 'vx-9')!.relevance).toBe(0.9);
    expect(clusters.find((c) => c.key === 'sen-210')!.memberIds).toHaveLength(1);
  });

  it('pools unmatched anchorless hits into the unanchored bucket', () => {
    const clusters = clusterBySubject(
      [
        hit({ subjectEntity: 'VX-9', fusedScore: 0.02 }),
        hit({ entities: ['Neptune'], fusedScore: 0.03, vectorScore: 0.7 }),
        hit({ entities: [], fusedScore: 0.01 }),
      ],
      fold,
    );
    const bucket = clusters.find((c) => c.key === '')!;
    expect(bucket.subject).toBe('');
    expect(bucket.memberIds).toHaveLength(2);
    expect(bucket.fused).toBe(0.03);
    expect(bucket.relevance).toBe(0.7);
  });

  it('treats a subject that folds to nothing as anchorless', () => {
    const clusters = clusterBySubject([hit({ subjectEntity: '***', fusedScore: 0.02 })], () => '');
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.key).toBe('');
  });

  it('founds a nameable cluster for an anchorless hit under a query-named entity', () => {
    // A legacy pre-anchoring fact answering an entity-named question: the
    // entity identity is the evidence anchoring would have provided.
    const clusters = clusterBySubject(
      [hit({ entities: ['Maja'], fusedScore: 0.03, vectorScore: 0.4 })],
      fold,
      ['Maja'],
    );
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.key).toBe('maja');
    expect(clusters[0]!.subject).toBe('Maja');
    // ...and rule 1 then resolves it dominant, even under the floor.
    const decision = decideAmbiguity(clusters, ['Maja'], fold, THRESHOLDS, META);
    expect(decision.branch).toBe('dominant');
    expect(decision.named).toEqual(['maja']);
  });

  it('prefers the query-named entity over attaching to an anchored cluster', () => {
    const clusters = clusterBySubject(
      [
        hit({ subjectEntity: 'VX-9', fusedScore: 0.05 }),
        hit({ entities: ['VX-9', 'Maja'], fusedScore: 0.02, vectorScore: 0.5 }),
      ],
      fold,
      ['Maja'],
    );
    expect(clusters.map((c) => c.key).sort()).toEqual(['maja', 'vx-9']);
    expect(clusters.find((c) => c.key === 'maja')!.memberIds).toHaveLength(1);
  });

  it('never founds a query cluster for an entity the question does not name', () => {
    const clusters = clusterBySubject([hit({ entities: ['Neptune'], fusedScore: 0.03 })], fold, [
      'Maja',
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.key).toBe('');
  });

  it('orders clusters by fused score, key as the tie-break', () => {
    const clusters = clusterBySubject(
      [
        hit({ subjectEntity: 'Beta', fusedScore: 0.02 }),
        hit({ subjectEntity: 'Alpha', fusedScore: 0.02 }),
        hit({ subjectEntity: 'Gamma', fusedScore: 0.03 }),
      ],
      fold,
    );
    expect(clusters.map((c) => c.key)).toEqual(['gamma', 'alpha', 'beta']);
  });

  it('returns nothing for no hits', () => {
    expect(clusterBySubject([], fold)).toEqual([]);
  });
});

describe('decideAmbiguity', () => {
  it('is silent when there are no clusters at all', () => {
    const decision = decideAmbiguity([], [], fold, THRESHOLDS, META);
    expect(decision.branch).toBe('silent');
    expect(decision.clusters).toEqual([]);
  });

  it('is silent when no cluster reaches the relevance floor', () => {
    const decision = decideAmbiguity(
      [
        cluster({ relevance: 0.89 }),
        cluster({ key: 'sen-210', subject: 'SEN-210', relevance: 0.5 }),
      ],
      [],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('silent');
  });

  it('counts a cluster exactly at the floor as relevant', () => {
    const decision = decideAmbiguity([cluster({ relevance: 0.9 })], [], fold, THRESHOLDS, META);
    expect(decision.branch).toBe('dominant');
  });

  it('fans out over several subjects sharing a partially-named name (two Anas)', () => {
    const decision = decideAmbiguity(
      [
        cluster({ key: 'ana kovac', subject: 'Ana Kovač', fused: 0.03, relevance: 0.5 }),
        cluster({ key: 'ana horvat', subject: 'Ana Horvat', fused: 0.028, relevance: 0.5 }),
      ],
      ['Ana'],
      fold,
      THRESHOLDS,
      META,
    );
    // The shared name is identity evidence per cluster: the floor does not
    // apply, and the fan-out covers exactly the subjects carrying the name.
    expect(decision.branch).toBe('fan_out');
    expect(decision.clusters.filter((c) => c.shown).map((c) => c.key)).toEqual([
      'ana kovac',
      'ana horvat',
    ]);
  });

  it('resolves a partial name to its unique subject', () => {
    const decision = decideAmbiguity(
      [
        cluster({ key: 'ana kovac', subject: 'Ana Kovač' }),
        cluster({ key: 'sen-210', subject: 'SEN-210' }),
      ],
      ['Ana'],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('dominant');
    expect(decision.named).toEqual(['ana kovac']);
  });

  it('treats a topic-named question as aggregation, never a fan-out (the atlas shape)', () => {
    // "The full scope of the Atlas CRM migration": no subject carries the
    // name, but members' entities do — an aggregation question about what
    // the clusters share, answered normally.
    const decision = decideAmbiguity(
      [
        cluster({ key: 'ana', subject: 'Ana', entityNamed: true, fused: 0.03 }),
        cluster({
          key: 'adriatic foods',
          subject: 'Adriatic Foods',
          entityNamed: true,
          fused: 0.028,
        }),
      ],
      ['Atlas CRM'],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('dominant');
    expect(decision.named).toEqual(['ana', 'adriatic foods']);
  });

  it('lifts an entity-named cluster over the relevance floor', () => {
    // "What is coming up with Adriatic Foods?" against a fact ABOUT Marko
    // that mentions Adriatic Foods: sub-floor similarity, but the identity
    // is the evidence — never silent, answers normally.
    const decision = decideAmbiguity(
      [cluster({ key: 'marko', subject: 'Marko', relevance: 0.89, entityNamed: true })],
      ['Adriatic Foods'],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('dominant');
  });

  it('carries the lift through clustering from a member entity match', () => {
    const clusters = clusterBySubject(
      [
        hit({
          subjectEntity: 'Marko',
          entities: ['Marko', 'Adriatic Foods'],
          fusedScore: 0.03,
          vectorScore: 0.89,
        }),
      ],
      fold,
      ['Adriatic Foods'],
    );
    expect(clusters[0]!.entityNamed).toBe(true);
    const decision = decideAmbiguity(clusters, ['Adriatic Foods'], fold, THRESHOLDS, META);
    expect(decision.branch).toBe('dominant');
  });

  it('lifts on a variant entity containing the query name, on token boundaries', () => {
    const named = clusterBySubject(
      [hit({ subjectEntity: 'Marko', entities: ['Adriatic Foods workshop'], vectorScore: 0.89 })],
      fold,
      ['Adriatic Foods'],
    );
    expect(named[0]!.entityNamed).toBe(true);
    // Token boundaries hold: "Foods" alone claims nothing, and a shorter
    // fact entity never claims a longer query name.
    const unnamed = clusterBySubject(
      [hit({ subjectEntity: 'Marko', entities: ['Foods'], vectorScore: 0.89 })],
      fold,
      ['Adriatic Foods'],
    );
    expect(unnamed[0]!.entityNamed).toBe(false);
  });

  it('lifts on the claim text carrying the query name the entity list missed', () => {
    // The strict_mode_hr shape the live gate caught: entities ["Marko"], the
    // company only in the claim, similarity 0.898 under the 0.90 floor.
    const clusters = clusterBySubject(
      [
        hit({
          subjectEntity: 'Marko',
          entities: ['Marko'],
          content: 'Marko owes the requirements list before the Adriatic Foods workshop.',
          vectorScore: 0.898,
        }),
      ],
      fold,
      ['Adriatic Foods'],
    );
    expect(clusters[0]!.entityNamed).toBe(true);
    const decision = decideAmbiguity(clusters, ['Adriatic Foods'], fold, THRESHOLDS, META);
    expect(decision.branch).toBe('dominant');
  });

  it('never claims silence over a relevant unanchored bucket', () => {
    const decision = decideAmbiguity(
      [cluster({ key: '', subject: '', relevance: 0.95 })],
      [],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('dominant');
  });

  it('resolves to dominant when the question names a cluster subject', () => {
    const decision = decideAmbiguity(
      [cluster(), cluster({ key: 'sen-210', subject: 'SEN-210', fused: 0.03 })],
      ['VX-9'],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('dominant');
    expect(decision.named).toEqual(['vx-9']);
  });

  it('resolves a named subject through an alias', () => {
    const decision = decideAmbiguity(
      [cluster(), cluster({ key: 'sen-210', subject: 'SEN-210' })],
      ['VX-9 Housing'],
      aliased,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('dominant');
    expect(decision.named).toEqual(['vx-9']);
  });

  it('treats a question naming several subjects as a comparison, not ambiguity', () => {
    const decision = decideAmbiguity(
      [cluster(), cluster({ key: 'sen-210', subject: 'SEN-210' })],
      ['VX-9', 'SEN-210'],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('dominant');
    expect(decision.named).toEqual(['vx-9', 'sen-210']);
  });

  it('lets a named subject win even below the relevance floor', () => {
    const decision = decideAmbiguity(
      [cluster({ relevance: 0.3 })],
      ['VX-9'],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('dominant');
  });

  it('never matches a named entity against the unanchored bucket', () => {
    const decision = decideAmbiguity(
      [cluster({ key: '', subject: '', relevance: 0.3 })],
      [''],
      fold,
      THRESHOLDS,
      META,
    );
    // The empty query fold matches nothing; sub-floor → silent.
    expect(decision.branch).toBe('silent');
  });

  it('is dominant with a single relevant cluster', () => {
    const decision = decideAmbiguity(
      [cluster(), cluster({ key: 'sen-210', subject: 'SEN-210', relevance: 0.4, fused: 0.028 })],
      [],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('dominant');
  });

  it('fans out over comparable relevant clusters, score order, shown flagged', () => {
    const decision = decideAmbiguity(
      [
        cluster({ fused: 0.03 }),
        cluster({ key: 'sen-210', subject: 'SEN-210', fused: 0.025, relevance: 0.95 }),
      ],
      [],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('fan_out');
    expect(decision.clusters.map((c) => c.shown)).toEqual([true, true]);
    expect(decision.capped).toBe(false);
  });

  it('counts a cluster exactly at the comparability ratio as comparable', () => {
    const decision = decideAmbiguity(
      [
        cluster({ fused: 0.04 }),
        cluster({ key: 'sen-210', subject: 'SEN-210', fused: 0.022, relevance: 0.95 }),
      ],
      [],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('fan_out'); // 0.022 = 0.55 × 0.04
  });

  it('is dominant when the runner-up falls below the ratio', () => {
    const decision = decideAmbiguity(
      [
        cluster({ fused: 0.04 }),
        cluster({ key: 'sen-210', subject: 'SEN-210', fused: 0.021, relevance: 0.95 }),
      ],
      [],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('dominant');
  });

  it('excludes a sub-floor cluster from the fan-out even when its rank is comparable', () => {
    const decision = decideAmbiguity(
      [
        cluster({ fused: 0.03 }),
        cluster({ key: 'sen-210', subject: 'SEN-210', fused: 0.03, relevance: 0.2 }),
      ],
      [],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('dominant');
  });

  it('is dominant when only the unanchored bucket is relevant', () => {
    const decision = decideAmbiguity(
      [
        cluster({ key: '', subject: '', relevance: 0.95, fused: 0.03 }),
        cluster({ relevance: 0.3 }),
      ],
      [],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('dominant');
  });

  it('is dominant when the unanchored bucket out-scores every nameable cluster', () => {
    const decision = decideAmbiguity(
      [
        cluster({ key: '', subject: '', relevance: 0.95, fused: 0.05 }),
        cluster({ fused: 0.03 }),
        cluster({ key: 'sen-210', subject: 'SEN-210', fused: 0.028, relevance: 0.95 }),
      ],
      [],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.branch).toBe('dominant');
  });

  it('caps the fan-out and says so', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((key, i) =>
      cluster({ key, subject: key.toUpperCase(), fused: 0.03 - i * 0.001, relevance: 0.95 }),
    );
    const decision = decideAmbiguity(many, [], fold, THRESHOLDS, META);
    expect(decision.branch).toBe('fan_out');
    expect(decision.clusters.filter((c) => c.shown)).toHaveLength(4);
    expect(decision.capped).toBe(true);
    // The strongest four are the shown four.
    expect(decision.clusters.slice(0, 4).every((c) => c.shown)).toBe(true);
  });

  it('records the full distribution, the config version and the embedding model', () => {
    const decision = decideAmbiguity(
      [
        cluster({ relevance: 0.61234 }),
        cluster({ key: 'sen-210', subject: 'SEN-210', relevance: 0.3 }),
      ],
      [],
      fold,
      THRESHOLDS,
      META,
    );
    expect(decision.configVersion).toBe(AMBIGUITY_CONFIG_VERSION);
    expect(decision.embeddingModel).toBe('test-embed');
    expect(decision.clusters).toHaveLength(2);
    expect(decision.clusters[0]!.relevance).toBe(0.6123); // stored at 4 decimals
    expect(decision.clusters[0]!.size).toBe(1);
    expect(decision.clusters[0]!.topMemoryId).toBe('m-001');
  });
});

describe('ambiguityThresholdsFor', () => {
  it('returns the calibrated entry for a known model', () => {
    expect(ambiguityThresholdsFor('mistral-embed')).toEqual(THRESHOLDS);
  });

  it('resolves an Ollama-style tag through the base name', () => {
    expect(ambiguityThresholdsFor('bge-m3:latest')).toEqual(ambiguityThresholdsFor('bge-m3'));
  });

  it('fails loudly on an unknown embedding model', () => {
    expect(() => ambiguityThresholdsFor('mystery-embed')).toThrow(/no calibrated ambiguity/);
  });
});

/**
 * Issue #477, reproduced from the live instance. Asked `what is m557?` over a
 * real corpus of fifteen matching facts, the product answered "I have nothing
 * about this in your sources". The stored decision record carried the exact
 * numbers below, so these are measurements, not invented fixtures.
 */
describe('false silence on an uncalibrated embedding model (issue #477)', () => {
  /** The live cluster distribution under bge-m3, from chat_message.ambiguity. */
  const liveClusters = (): AmbiguityCluster[] => [
    cluster({
      key: 'm557',
      subject: 'M557',
      relevance: 0.8191,
      fused: 0.0164,
      memberIds: ['a', 'b', 'c', 'd', 'e', 'f'],
    }),
    cluster({
      key: 'm557 mechanical artillery fuze',
      subject: 'M557 Mechanical Artillery Fuze',
      relevance: 0.7674,
      fused: 0.0149,
      memberIds: ['g'],
    }),
    cluster({
      key: 'mounting bracket',
      subject: 'mounting bracket',
      relevance: 0.6746,
      fused: 0.0132,
      memberIds: ['h'],
    }),
    cluster({
      key: 'guide rail',
      subject: 'guide rail',
      relevance: 0.6719,
      fused: 0.0128,
      memberIds: ['i'],
    }),
    cluster({
      key: 'pump housing',
      subject: 'pump housing',
      relevance: 0.6638,
      fused: 0.0125,
      memberIds: ['j'],
    }),
  ];

  it('does NOT go silent when the floor was borrowed rather than measured', () => {
    // The exact live input: no query-named entity (the lowercase identifier was
    // invisible to the candidate scan), every cluster under a 0.90 floor that
    // was calibrated on a different embedding model.
    const decision = decideAmbiguity(
      liveClusters(),
      [],
      (n) => n.toLowerCase(),
      UNCALIBRATED,
      META,
    );
    expect(decision.branch).not.toBe('silent');
    expect(decision.branch).toBe('dominant');
  });

  it('still goes silent on an uncalibrated model when retrieval returned nothing', () => {
    // Silence must stay reachable: it is honest under any geometry, because it
    // is about the absence of results rather than about a similarity value.
    const decision = decideAmbiguity([], [], (n) => n.toLowerCase(), UNCALIBRATED, META);
    expect(decision.branch).toBe('silent');
  });

  it('still goes silent on a CALIBRATED model whose measured floor nothing clears', () => {
    // The branch is not weakened where the geometry was actually measured.
    const decision = decideAmbiguity(liveClusters(), [], (n) => n.toLowerCase(), THRESHOLDS, META);
    expect(decision.branch).toBe('silent');
  });

  it('answers from memory once the identifier is named, on either model', () => {
    for (const thresholds of [THRESHOLDS, UNCALIBRATED]) {
      const decision = decideAmbiguity(
        liveClusters(),
        ['m557'],
        (n) => n.toLowerCase(),
        thresholds,
        META,
      );
      expect(decision.branch).toBe('dominant');
      expect(decision.named).toContain('m557');
    }
  });

  it('the shipped bge-m3 entry cannot silence a corpus', () => {
    // The regression guard on the config itself, not just the decision rule.
    expect(ambiguityThresholdsFor('bge-m3').calibrated).toBe(false);
    const decision = decideAmbiguity(
      liveClusters(),
      [],
      (n) => n.toLowerCase(),
      ambiguityThresholdsFor('bge-m3'),
      META,
    );
    expect(decision.branch).not.toBe('silent');
  });
});
