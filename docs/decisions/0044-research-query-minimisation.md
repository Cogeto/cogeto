# 0044 — Research query minimisation (Priority 5 Part B)

Date: 2026-07-22. Status: accepted. Context: Post-v1 Backlog Priority 5
(query minimisation), with decision 0045 (the gate). Companion to 0042/0043.

## The premise: no false "nothing leaves" claim

A web search query itself LEAVES the instance — that is what searching the
public web means, and no architecture changes it. Pseudonymising the query
(the redaction sidecar's NER swap) would break it: "ORG_1 GDPR consent CRM"
finds nothing useful, and un-swappable context still identifies. So the honest
mechanism is **minimisation plus disclosure plus approval** (0045), never a
pretend-private search.

## Ruling 1 — Minimisation is a pipeline-tier rewrite, not sidecar redaction

The backlog's "redaction-tier pass" is realised as a small-model rewrite:
prompt family `research_query_minimise` (v0001, versioned/immutable per §B.7)
on the **pipeline tier** through the normal gateway — which is itself
redaction-wrapped when the `redaction` profile is on, so even the minimisation
call obeys the instance's PII posture. It returns the minimised query, what
was removed/kept, and a ONE-line reason the gate shows verbatim.

## Ruling 2 — The subject rule, conservative by construction

Drop an entity that merely anchors a general question ("Adriatic Foods GDPR
consent CRM migration" → "GDPR consent requirements CRM migration"); KEEP an
entity that is itself the research subject (researching a company by name);
**when unsure, keep it** — the user reviews at the gate and deletes a name in
one keystroke, so the conservative failure mode is "asked the user", never
"silently leaked" or "silently broke the search". Public entities (laws,
regulations, released products) are topical substance, kept freely.

## Ruling 3 — Failure opens to the gate, never to the network

If the minimisation call fails, the proposed query is returned UNCHANGED with
an honest reason ("minimisation was unavailable — review the query yourself").
This is safe precisely because of 0045: nothing is sent without the user
seeing and approving the text, so a minimiser outage degrades to manual
review, not to leakage.

## Verification

Contract + prompt-rule tripwires: `minimise_reports`, `minimise_drops_client`,
`minimise_keeps_subject` (connectors `research-minimise.spec`). LIVE rewriting
behaviour: the research chat-eval cases judge the query that actually left —
`research_minimise_drop` (the client name must be gone from the sent query)
and `research_keeps_subject_hr` (the subject entity must survive).
