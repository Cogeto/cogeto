# en-0003 — relative date resolution

"Next Friday" must resolve against the source timestamp (the harness's
reference time, Wed 2026-07-01), not against whenever the extractor runs.
Labeling rule 3: resolving it is part of what is tested — the extraction should
either produce a concrete ISO date in `temporal.valid_until` or leave it null
with `anchors_resolved: false`; a rotting literal "next Friday" inside the
claim with `anchors_resolved: true` is the failure mode. The harness v0 scores
matching, not temporal accuracy — the label documents intent for Session 4's
gated metrics.
