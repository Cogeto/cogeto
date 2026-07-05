-- Migration 0009 — deletion receipt signature (Session F1, §B.1, decision 0008).
-- Receipts are hash-chained AND signed with the instance ed25519 key; 0001 gave
-- the chain columns (prev_hash, hash) but nowhere to store the signature.
-- The signature is over the SHA-256 chain hash of the canonical receipt payload
-- (see memory/domain/receipt-chain.ts), base64-encoded.

ALTER TABLE deletion_receipt ADD COLUMN signature text;

-- The worker's confirmation step finds the chain tip by "confirmed receipt whose
-- hash no other confirmed receipt links to" — index the linkage lookups.
CREATE INDEX deletion_receipt_status_idx ON deletion_receipt (status);
CREATE INDEX deletion_receipt_prev_hash_idx ON deletion_receipt (prev_hash);
