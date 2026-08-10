# Ambiguity detection and fan-out answers

**V2.3 item 6.3. The decision record, frozen before the code. Spec §7.5 is the
normative rule. The decision is computed in `retrieval` (it owns the fused
scores), acted on in `chat` (it owns the answer), recorded on `chat_message`
(migration 0050). Detection is deterministic and costs no model call.**

A question that could be about several distinct subjects the corpus holds
facts for must not be answered by silently picking one, and must not be
answered with a bare "which did you mean?" either. Cogeto fans out: one line
per candidate subject with its fact, its citation, and its verdict where one
deviates from plain active, ending by asking which was meant. When the corpus
holds nothing relevant, the answer says so explicitly before offering general
knowledge under the existing not-from-your-sources marking. Spec §7.5.4 makes
both a silent guess and a bare clarifying question defects.

## What a cluster is

After fusion, the surviving results are grouped by **anchored subject
entity**, the field V2.1 item 4.2 exists to make trustworthy:

1. The cluster key is the **alias-canonical folded subject**:
   `foldEntityName(subjectEntity)` resolved through the owner's
   `entity_alias` set (the 6.1 union-find), so "VX-9 Housing" and "VX-9",
   or a Croatian genitive alias and its nominative, land in ONE cluster.
   Without alias awareness the same subject splits in two and the feature
   interrogates the user about a distinction that does not exist, which is
   the eager failure mode. The alias read is one indexed query per turn
   through ingestion's public interface.
2. A fact **without** a subject entity (pre-anchoring rows, some captures)
   first checks the entities the **question itself names**: when one of its
   folded entities matches a query entity, it founds or joins a nameable
   cluster under that entity, because the entity identity is the evidence
   anchoring would have provided. This is what keeps a legacy pre-anchoring
   corpus answering "what do I owe Maja?" exactly as before: the founded
   cluster is query-named, so rule 1 resolves it dominant whatever its
   similarity. Otherwise it attaches to an existing subject cluster when one
   of its folded entities equals that cluster's key. What remains pools into
   a single `unanchored` bucket.
3. The `unanchored` bucket is **never a fan-out candidate**: a line that
   cannot name its subject cannot ask "did you mean this one?". When the
   only relevant material is unanchored, the decision is `dominant` and the
   answer path behaves exactly as today. This errs conservative for legacy
   data only; everything ingested since 4.2 is anchored.

## The cluster score, honestly defined

Two different questions need two different signals, and neither signal alone
answers both:

- **Relevance** ("does this cluster bear on the question at all?") is the
  cluster's **best member vector similarity**, the normalized [0,1] cosine
  the memory module returns. This is the only score in the pipeline with
  absolute meaning, and it is embedding-model geometry, which is why the
  relevance floor is calibrated per embedding model. The fused RRF score
  cannot carry a floor: it is rank-derived, so some cluster is always near
  the top of it even when the whole result list is noise. A cluster none of
  whose members were surfaced by the vector signal has relevance 0 and can
  only count by being named in the question (below).
- **Comparability** ("do two clusters answer this question about equally
  well?") is the ratio of **fused cluster scores**, where a cluster's fused
  score is the **maximum** fused score among its members, never a sum or a
  mean. Max is deliberate: RRF already encodes cross-signal consensus per
  fact, and taking the cluster maximum makes a cluster with one strong fact
  and a cluster with many weak ones comparable by their best evidence. A sum
  would let volume beat relevance, which is exactly the failure the plan
  names: a subject with forty boilerplate rows would dominate a subject with
  one precise answer.

The vector similarity was not previously carried past fusion; it now rides
along on each retrieved hit. This is the sanctioned widening of the
deterministic signal: the alternative, asking a model whether the question is
ambiguous, costs latency on every question and makes the behaviour
unexplainable.

## The decision rule

A pure function (`retrieval/ambiguity.ts`), inputs the clusters with their two
scores plus the query's entity candidates, output the decision plus the
clusters involved. Evaluated in order:

1. **Named subject wins, split by WHAT the name matches**, because the three
   shapes mean three different things. **Exact subject match** (alias-aware,
   against the query entity candidates): deliberate naming; one subject is
   the fragment or follow-up resolution, several is a comparison the normal
   answer path already handles; `dominant`. **Partial subject match** ("Ana"
   against "Ana Kovač", either direction on token boundaries): a unique
   match resolves to the one subject carrying the name, `dominant`; SEVERAL
   subjects sharing the queried name is precisely the two-Anas ambiguity and
   fans out over exactly those subjects, floor-exempt, because the shared
   name is identity evidence per cluster. **Topic match** (the name appears
   in members' entities or claim text but in no subject): an aggregation
   question about something the clusters' facts share, "the full scope of
   the Atlas CRM migration"; `dominant`, because a fan-out there would
   interrogate the user about a distinction they did not ask about. The
   live gate caught exactly that shape regressing, which is why the split
   exists.
2. **Relevance floor, with the identity lift.** Clusters whose relevance is
   below the floor drop out, EXCEPT a cluster in which a query-named entity
   appears (a member's subject, entities, or claim text carries it on token
   boundaries): identity evidence substitutes for geometric evidence, the
   exact reasoning the reconcile config records for its alias exemption. The
   live gate forced this rule too: "what is coming up with Adriatic Foods?"
   against a fact ABOUT Marko whose claim mentions Adriatic Foods measured
   0.898 relevance, under the 0.90 floor but above the 0.876 irrelevant
   band, a gap no floor can split. If nothing survives, the decision is
   `silent`.
3. **Comparability.** Among survivors, every cluster whose fused score is at
   least `comparabilityRatio` times the top cluster's fused score is a
   candidate. One candidate: `dominant`. Several: `fan_out`, candidates in
   fused-score order.

The tie-break everywhere is deterministic: score, then cluster key.

## Recording the decision

Every assistant answer on the grounded path stores its decision in
`chat_message.ambiguity` (jsonb, migration 0050, chat-owned): the branch, the
clusters considered with subject, both scores and member count, which were
shown, the named entity when rule 1 fired, the config version and the
embedding model. This is how a puzzling answer is diagnosed from stored data
rather than by re-running with logging. The record carries subject names, so
it is content-bearing: the answer redaction cascade clears it with the answer,
and the deletion story is unchanged everywhere else. The live `done` event and
the messages API carry it to the SPA.

## The three behaviours

**Dominant** is byte-identical to today: same facts, same prompt input, same
citations. The overwhelming majority of questions take this branch and the
existing chat evals hold it still.

**Silent** splits by the rewriter's question class, which is already
deterministically vetoed:

- Knowledge-class: a localized, server-authored preamble states plainly that
  the user's sources hold nothing about this, then the model answers from
  general knowledge under `GENERAL KNOWLEDGE: allowed` with every claim
  `[U]`-marked, rendering under the existing unsourced treatment. The
  sub-floor facts are withheld from the model so it cannot cite something the
  preamble just disclaimed; the sources frame is empty for the same reason.
  The considered clusters stay inspectable on the decision record.
- Personal-class with profile context or attachments: unchanged, those are
  provided ground and corpus silence is not the story.
- Personal-class otherwise: the existing deterministic `nothingOnRecord`
  reply, which is already the explicit statement, now reached also when weak
  sub-floor noise was retrieved instead of only on zero rows.

**Fan-out** is a fully server-authored, deterministic message, no model call:
an intro line, then one line per candidate in score order, each carrying the
cluster's best fact verbatim with its real `{{cite:<id>}}` token (the chip
renders with its status tone exactly like every other citation) and a
localized verdict suffix when the fact's status deviates from plain active
(unconfirmed, contradicted, past), then "which did you mean?". Lines are
capped at `MAX_FANOUT_LINES`; when more subjects matched, a line says how
many more, plainly. A deterministic string cannot mirror the question's
language, so it follows the anchor language, the same rule every
server-authored reply already follows. The user often gets the answer from
the fan-out itself without replying; when they do reply, rule 1 resolves it
without re-fanning, helped by a deterministic check of the previous
assistant message's stored fan-out subjects against the reply.

## Thresholds, calibration, and the chosen trade

Both thresholds live in `retrieval/ambiguity-config.ts`, versioned as
`AMBIGUITY_CONFIG_VERSION` exactly like the reconcile config: calibrated per
embedding model, exact name first then the base name before any `:tag`, and
an unknown embedding model **fails loudly** rather than borrowing another
model's geometry. `test-embed` mirrors the canonical cut points so the suites
exercise the shipped bands; only measured models get a "calibrated" claim,
everything else carries an honest "borrowed" comment.

**Calibrated 2026-08-07, live on `mistral-default`**, over the chat-suite
ambiguity corpora (seeded facts, real fusion, real rewriter). What was
measured, and what it taught:

- mistral-embed's normalized similarities are compressed and high. Clusters
  holding the asked-about attribute scored **0.92 to 0.94**; foreign-topic
  clusters scored **0.79 to 0.876**, the worst irrelevant draw being a
  Croatian question against Croatian facts on an unrelated topic. The
  relevance floor is **0.90**, inside the measured gap.
- The fused-score ratio cannot discriminate relevance in a small corpus:
  single-signal clusters at adjacent RRF ranks sit near **0.97** whatever
  their similarity, which is why the relevance floor also gates fan-out
  candidates (a sub-floor cluster never earns a line; the first calibration
  round showed an unrelated project on a fan-out line without this). What
  the ratio genuinely measures is **signal consensus**: a cluster the
  question's entities also matched carries two or three RRF contributions
  against one, pushing the runner-up to about 0.33 to 0.5 (measured 0.49
  live). The comparability ratio is **0.55**, above the consensus gap and
  far below same-signal adjacency.
- The named-subject rule resolved every fragment and follow-up in both
  languages on the calibration runs, including a Croatian fragment whose
  subject arrived only through the rewriter's history resolution.

The failure modes, stated per the plan:

- Too eager a fan-out interrogates the user on ordinary questions and feels
  evasive. The structural defence is rule 1: ordinary questions
  overwhelmingly name their subject, and a named subject never fans out.
  Alias-aware clustering removes the false split that would otherwise fan
  out over one real subject under two names.
- Too conservative a fan-out silently answers about the wrong product model,
  the failure this feature exists to prevent. On the slice that remains
  after rule 1 (a question naming no subject while several relevant subjects
  exist), the comparability ratio errs **toward fanning out**, because that
  slice is precisely where the silent-guess hazard lives, and a fan-out
  there still hands the user the answer they wanted one line down.
- The relevance floor sits in the measured gap between the bands rather than
  below it, because the irrelevant band under mistral-embed reaches 0.876
  and a floor below it would never let the silent branch fire. The residual
  risk on the floor's low side is a weakly-relevant unnamed question landing
  on the deterministic nothing-on-record reply instead of a model answer
  over weak facts; the residual risk on its high side is fanning out over
  noise, which round one measured and the floor now prevents. Between those
  two, the honest statement of silence is the smaller harm, and the decision
  record on the message makes any wrong call diagnosable from stored data.

So: silence claimed only under the measured irrelevant band, structural
protection against eager fan-out on named questions, deliberately eager on
the genuinely ambiguous remainder.

## What is deliberately not here

- **No model call and no new prompt version.** Detection is arithmetic over
  scores retrieval already computes; the fan-out and the silence preamble
  are server-authored; the dominant branch's prompt input is unchanged, so
  `answer/v0008` stands and the golden-set eval cache is untouched.
- **No user configuration.** Spec §7.5 requires one behaviour always.
- **No new table.** The decision rides the message it explains.
- **No re-ranking change.** Fusion, gates and multipliers are untouched;
  the vector similarity is carried alongside, never re-applied.

## Eval gating

The three plan-named cases, authored in English and Croatian in the chat
suite: a context-resolved fragment that must pick the thread's subject and
not fan out; a cold ambiguous value question that must fan across exactly the
subjects holding related facts; a silent-corpus question that must banner
general knowledge without fabricating a source. Beside them, the edges the
behaviour needs: an ordinary question asserting the dominant branch on
existing cases, a fan-out followed by the disambiguating reply resolving
cleanly across turns, a weak-dominance boundary case, and a many-subjects
case that must cap and say so. Branch assertions are deterministic rule
checks in the chat harness (all-must-pass, so they gate), the harness prints
the branch distribution across the whole suite so the fan-out rate is
measured rather than assumed, and the pure decision rule is unit-tested
exhaustively without the stack. Per gate-model.md, this closes the "ambiguity
handling remains ungated" gap named there; the dedicated published metric
lands with item 6.4 like anchoring's did.

## What the question is about, and who decides it (issue #479)

*Added 2026-08-10, with `answer/v0009` and migration 0051.*

The ambiguity decision used to end at the branch. It chose `dominant`, the
grounded answer path ran, and the decision was written to
`chat_message.ambiguity` for diagnostics. The answering model received the
facts and the user's **raw** question and nothing else.

That is a gap, and it showed. Asked `what is m557?` and then `How does it look
like?`, the pipeline resolved the pronoun, retrieved the right facts and
recorded `named: ["m557"]`. The answerer then received six words beside fifteen
subjects and reasoned its way to a guess:

> "The user asks 'How does it look like?' without specifying what."
> "the M557 is the only entity with specific visual description facts ... it is
> highly likely the user refers to the M557"

Right answer, wrong method. It succeeded by **elimination**, because M557 was
the only retrieved subject carrying appearance facts, and it drafted a hedge
across two unrelated products in case it was wrong. With several visually
described subjects in the retrieved set, elimination fails and the model picks
by fact density: a confidently wrong subject, correctly cited.

**The subject was never unknown. It was computed, recorded, and discarded.**

### Three layers, and why in this order

1. **The resolved subject and the resolved question.** `resolveAnswerSubject`
   reads the decision back out and the answer input states
   `THE QUESTION IS ABOUT`, with the rewriter's resolved form under the user's
   own words. Deterministic, a handful of tokens, no second model call and no
   second chance to be wrong.
2. **A fenced `RECENT TURNS` block**, four turns, each flattened to one bounded
   line. For the discourse a subject cannot express ("what about the other
   one", "and in metric"). Fenced exactly as attachments are: prior turns carry
   text a user or a document wrote, and an instruction pasted into a chat must
   not survive into the next answer.
3. **The conversation focus** (`conversation.focus_subject`, migration 0051):
   the subject carried forward so a pronoun still binds after a digression.
   Rendered as "carried over", because it is a working assumption from an
   earlier turn rather than something the user just said.

### The rules that keep it honest

- **A subject is asserted only when one was RESOLVED.** `named` is the record
  of rule 1, the question's own naming. A branch reached by score alone
  resolved nothing, and stating a subject there would repeat the original
  error one layer down. Several named subjects is a comparison, not a subject,
  and asserts nothing either.
- **A stale focus is dropped, not warned about.** Twelve hours: long enough
  that a lunch break does not lose the thread, short enough that tomorrow's
  "how does it look" is not silently answered about yesterday's part. An
  assumption the user cannot see is worse than none, and the prompt already
  tells the model to say which subject it chose when nothing was resolved.
- **A carried subject does not refresh its own age**, or one subject would stay
  alive forever in a long conversation.
- **The conversation says what is asked; the facts say what is true.**
  `answer/v0009` states it directly: a claim that appears only in an earlier
  turn is not on record. Citations, `{{cite}}` tokens and the memory-first rule
  are unchanged.
- **The silent branch carries NO turns.** When the decision is `silent` and
  general knowledge answers, the sub-floor facts are withheld from the prompt
  so the model cannot cite what the preamble has just disclaimed. An earlier
  assistant turn quoting one of those facts would put it straight back in
  front of the model, so the turns block is withheld on that path for exactly
  the same reason. The subject line survives: a subject NAME is not a claim,
  and it is what lets the answer say "I have nothing about the M557" instead
  of a bare shrug. Asserted by the existing
  `chat-ambiguity.integration.spec.ts` silent-plus-knowledge case, which
  caught this during implementation.

### What gates it

A follow-up case with only one visually described subject **passes with the bug
present**, by elimination, and proves nothing. The gating case
(`followup_two_visual_subjects_en`) gives TWO retrieved subjects appearance
facts and requires the answer to describe the one the conversation was about
and to mention neither the other subject nor its attributes.
`followup_focus_after_digression_en` covers layer 3: name a subject, ask
something unrelated, then use a pronoun.
