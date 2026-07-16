-- 0024 — calendar-invite parsing (Session O4, GAP-4). A meeting invite arrives
-- as a text/calendar (VEVENT) part whose event details never reach the human
-- body, so an invite-only email extracted weakly. Intake now parses the VEVENT
-- deterministically into a stable text summary, stored here; the email
-- SourceReader appends it to the extraction input AFTER quote/signature
-- isolation, so the extractor always sees the event. Additive + nullable;
-- deleted with the row (covered by the existing email deletion cascade).
ALTER TABLE email_message ADD COLUMN calendar_summary text;
