-- Additive migration. An owner may queue one Council Workflow per record and seat.
-- Must not delete, rewrite, or merge any immutable existing records.
CREATE UNIQUE INDEX IF NOT EXISTS idx_council_workflow_owner_record_seat_unique
ON council_workflow_links(owner_email, record_id, seat);
