-- Durable founder drafts, NOT the public sealed GitHub message ledger.
-- Only the Access-authenticated founder may reach this database through the API.
CREATE TABLE IF NOT EXISTS council_records (
 id TEXT PRIMARY KEY,
 owner_email TEXT NOT NULL,
 claim TEXT NOT NULL,
 evidence_json TEXT NOT NULL,
 claim_sha256 TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_council_records_owner_date ON council_records(owner_email,created_at DESC);
CREATE TRIGGER IF NOT EXISTS council_records_no_update BEFORE UPDATE ON council_records BEGIN SELECT RAISE(ABORT,'records append-only'); END;
CREATE TRIGGER IF NOT EXISTS council_records_no_delete BEFORE DELETE ON council_records BEGIN SELECT RAISE(ABORT,'records append-only'); END;
CREATE TABLE IF NOT EXISTS council_workflow_links (
 id TEXT PRIMARY KEY,
 owner_email TEXT NOT NULL,
 record_id TEXT NOT NULL REFERENCES council_records(id),
 seat TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_council_workflow_owner_date ON council_workflow_links(owner_email,created_at DESC);
CREATE TRIGGER IF NOT EXISTS council_workflow_no_update BEFORE UPDATE ON council_workflow_links BEGIN SELECT RAISE(ABORT,'workflow links append-only'); END;
CREATE TRIGGER IF NOT EXISTS council_workflow_no_delete BEFORE DELETE ON council_workflow_links BEGIN SELECT RAISE(ABORT,'workflow links append-only'); END;
CREATE TABLE IF NOT EXISTS council_events (
 id TEXT PRIMARY KEY,
 owner_email TEXT NOT NULL,
 action TEXT NOT NULL,
 subject_id TEXT NOT NULL,
 details_json TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_council_events_owner_date ON council_events(owner_email,created_at DESC);
CREATE TRIGGER IF NOT EXISTS council_events_no_update BEFORE UPDATE ON council_events BEGIN SELECT RAISE(ABORT,'events append-only'); END;
CREATE TRIGGER IF NOT EXISTS council_events_no_delete BEFORE DELETE ON council_events BEGIN SELECT RAISE(ABORT,'events append-only'); END;
