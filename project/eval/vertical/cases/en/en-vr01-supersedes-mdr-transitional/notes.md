# en-vr01: MDR transitional deadline, superseded by the 2023 amendment

**Sides.** `a` from `mdr-amend-2023-607-en` page 4 (case `en-v003`); `b` from
`mdr-2017-745-en` page 89 (case `en-v002`).

**Expected.** `supersedes_a_over_b`.

**Reasoning.** The two statements answer the same question, "until when may a
legacy device be placed on the market", and give different dates. They are not
a contradiction to hand to a user, because one document explicitly amends the
other: Regulation (EU) 2023/607 replaces Article 120(3) of Regulation (EU)
2017/745. Rule 2 of LABELLING.md: same subject, same slot, same conditions, but
NOT both current, so it is supersession.

The direction is the whole test. `a` is the more recently recorded fact and it
must win; a verdict of `supersedes_b_over_a` would tell a compliance reader the
2017 deadline still stands, which is the most expensive kind of wrong answer
this product can give.

AMBIGUOUS: the two spans are not literally the same paragraph. 2023/607 replaces
paragraph 3, and the 27 May 2025 date labelled here is paragraph 4, which the
amendment does not touch. They are paired because they answer the same practical
question with different dates, which is how a reader meets them. A stricter
labeller could call them different slots and expect `compatible`. The
conservative reading under rule 0 would be `compatible`; this pair deliberately
takes the harder position because the practical question is the one the product
is sold on, and the reasoning is written here so the call can be argued.
