-- Enable UUID extension (once per DB)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Migration tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT UNIQUE NOT NULL,
  applied_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Rounds table
CREATE TABLE IF NOT EXISTS rounds (
  id SERIAL PRIMARY KEY,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  drawn_numbers INTEGER[] NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  closed_at TIMESTAMP NULL
);

-- Tickets table
CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  round_id INTEGER NOT NULL REFERENCES rounds(id) ON DELETE RESTRICT,
  national_id VARCHAR(20) NOT NULL,
  numbers INTEGER[] NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- index for current round lookups
CREATE INDEX IF NOT EXISTS idx_rounds_active ON rounds(is_active);
CREATE INDEX IF NOT EXISTS idx_tickets_round ON tickets(round_id);
