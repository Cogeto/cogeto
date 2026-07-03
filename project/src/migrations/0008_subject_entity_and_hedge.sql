-- Migration 0008 — subject entity + hedge phrase (S3.5-B; F1, F4, F7).
-- extraction/v0002 emits, per fact, the entity the fact is primarily ABOUT
-- (distinct from other mentioned entities — the Marta-inclusion note is ABOUT
-- Ana) and, when the source states the claim tentatively, the hedge phrase.
--   memory.subject_entity  — surfaced to the answerer so a fact ABOUT Ana that
--                            MENTIONS Marta is never presented as being about Marta.
--   verification_result.hedge_phrase — the tentative wording that made the
--                            memory uncertain (shown in the review queue / drawer).
-- Both nullable; empty for pre-v0002 rows. Additive and safe mid-session.

ALTER TABLE memory ADD COLUMN subject_entity text;
ALTER TABLE verification_result ADD COLUMN hedge_phrase text;
