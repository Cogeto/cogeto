-- 0046: persisted span locators (V2.2 item 5.2).
--
-- The reader seam has emitted a structured locator per segment since V2.1
-- item 4.1, and deliberately nothing consumed them: the Sources surface and
-- the findings report are the consumers, and they arrive now. The resolution
-- from a fact's verified span to its locators happens ONCE, at admission,
-- where the reader's segments are still in hand -- a discard-mode original
-- cannot be re-read later, and re-parsing a document on every page view to
-- say where a fact came from would be reading it twice.
--
-- Two columns, both ingestion-owned, both nullable JSON arrays of ReadLocator
-- ({kind: page|paragraph|sheet_row|document, ...}, the shared vocabulary):
--
--   verification_result.span_locators: where the admitted fact's span sits in
--   the original (page and tier, paragraph, or sheet + A1 cell range).
--
--   suppressed_fact_log.span_locators: the same for a withheld or demoted
--   fact -- what Cogeto declined to trust deserves a position as much as what
--   it accepted.
--
-- NULL means "no location", deliberately covering three honest cases the
-- surface renders the same way: the source has no segments (notes, chat,
-- email bodies, web pages), locateSpan could not find the span (its empty
-- answer is "we cannot say where", never a guess), and rows admitted before
-- this migration (history is not fabricated; old facts read "no location
-- recorded").

ALTER TABLE verification_result ADD COLUMN span_locators jsonb;
ALTER TABLE suppressed_fact_log ADD COLUMN span_locators jsonb;
