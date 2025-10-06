ALTER TABLE tickets ADD COLUMN IF NOT EXISTS user_sub TEXT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_user_round ON tickets(user_sub, round_id);
