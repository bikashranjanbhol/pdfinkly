-- Scanning with a phone for a computer: the computer shows a QR code holding a
-- one-time token; the phone uses it to send finished pages, which the computer
-- picks up. Pages are deleted once picked up, and everything within the hour.

CREATE TABLE scan_handoffs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,  -- the computer's visitor
  token_hash     text NOT NULL UNIQUE,                                   -- sha256 of the QR token
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,                                   -- extended while the phone is active, never past created_at + 1 hour
  phone_seen_at  timestamptz,
  closed_at      timestamptz
);
CREATE INDEX scan_handoffs_user_idx ON scan_handoffs (user_id);
CREATE INDEX scan_handoffs_expiry_idx ON scan_handoffs (expires_at);

CREATE TABLE scan_handoff_pages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  handoff_id   uuid NOT NULL REFERENCES scan_handoffs(id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  storage_key  text NOT NULL,
  width        integer NOT NULL CHECK (width > 0),
  height       integer NOT NULL CHECK (height > 0),
  size_bytes   integer NOT NULL CHECK (size_bytes > 0),
  ready        boolean NOT NULL DEFAULT false,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (handoff_id, seq)
);
