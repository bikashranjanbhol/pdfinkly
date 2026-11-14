-- =====================================================================
-- PDFInkly: Postgres schema
-- Target: PostgreSQL 15+ (Neon or Supabase)
-- Holds metadata only. PDF bytes live in object storage (Vercel Blob,
-- S3 or R2); rows keep the object's storage key.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS citext;   -- case-insensitive emails

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
CREATE TYPE payment_provider    AS ENUM ('stripe', 'razorpay');
CREATE TYPE subscription_status AS ENUM ('trialing', 'active', 'past_due', 'cancelled', 'expired');
CREATE TYPE payment_status      AS ENUM ('pending', 'succeeded', 'failed', 'refunded');
CREATE TYPE file_status         AS ENUM ('uploading', 'ready', 'processing', 'failed');
CREATE TYPE version_source      AS ENUM ('upload', 'edit', 'job');
CREATE TYPE job_type            AS ENUM ('compress', 'ocr', 'pdf_to_docx', 'pdf_to_xlsx',
                                         'pdf_to_pptx', 'office_to_pdf', 'encrypt', 'decrypt');
CREATE TYPE job_status          AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');
CREATE TYPE share_permission    AS ENUM ('view', 'edit');
CREATE TYPE signature_kind      AS ENUM ('drawn', 'typed', 'uploaded');
CREATE TYPE usage_kind          AS ENUM ('upload', 'job');

-- Keeps updated_at current on every UPDATE
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =====================================================================
-- Billing: plans (needed first, users reference it)
-- =====================================================================
CREATE TABLE plans (
  id                text PRIMARY KEY,               -- 'free', 'pro', 'business'
  name              text NOT NULL,
  max_file_mb       integer NOT NULL CHECK (max_file_mb > 0),
  monthly_jobs      integer CHECK (monthly_jobs >= 0),   -- NULL = unlimited
  retention_hours   integer CHECK (retention_hours > 0), -- NULL = keep until deleted
  features          jsonb NOT NULL DEFAULT '{}',    -- e.g. {"ocr": true, "office": true}
  stripe_price_id   text UNIQUE,                    -- prices live in the provider
  razorpay_plan_id  text UNIQUE,
  is_active         boolean NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- Identity (shape follows the Auth.js adapter tables)
-- =====================================================================
CREATE TABLE users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           citext UNIQUE,                    -- NULL only for guests
  name            text,
  image_url       text,
  email_verified  timestamptz,
  is_guest        boolean NOT NULL DEFAULT false,
  plan_id         text NOT NULL DEFAULT 'free' REFERENCES plans(id),  -- current plan, for fast limit checks
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  deleted_at      timestamptz,                      -- soft delete
  CONSTRAINT users_email_unless_guest CHECK (is_guest OR email IS NOT NULL)
);

CREATE TABLE accounts (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                 text NOT NULL,               -- 'oauth' | 'email'
  provider             text NOT NULL,               -- 'google' | 'github'
  provider_account_id  text NOT NULL,
  refresh_token        text,
  access_token         text,
  expires_at           bigint,
  token_type           text,
  scope                text,
  id_token             text,
  session_state        text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_account_id)
);

CREATE TABLE sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_token  text NOT NULL UNIQUE,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE verification_tokens (
  identifier  text NOT NULL,                        -- email address
  token       text NOT NULL,
  expires_at  timestamptz NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- =====================================================================
-- Billing: subscriptions, payments, webhook log
-- =====================================================================
CREATE TABLE subscriptions (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_id                   text NOT NULL REFERENCES plans(id),
  provider                  payment_provider NOT NULL,
  provider_subscription_id  text NOT NULL,
  provider_customer_id      text,
  status                    subscription_status NOT NULL,
  current_period_start      timestamptz,
  current_period_end        timestamptz,
  cancel_at_period_end      boolean NOT NULL DEFAULT false,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_subscription_id)
);

CREATE TABLE payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users(id),        -- kept for accounting: no cascade
  subscription_id      uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  provider             payment_provider NOT NULL,
  provider_payment_id  text NOT NULL,
  amount_minor         bigint NOT NULL CHECK (amount_minor >= 0),  -- paise / cents
  currency             char(3) NOT NULL,                           -- 'INR', 'USD'
  status               payment_status NOT NULL,
  paid_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_payment_id)
);

CREATE TABLE webhook_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider      payment_provider NOT NULL,
  event_id      text NOT NULL,                      -- provider's event id
  event_type    text NOT NULL,
  payload       jsonb NOT NULL,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz,
  error         text,
  UNIQUE (provider, event_id)                       -- makes webhook handling idempotent
);

-- =====================================================================
-- Documents
-- =====================================================================
CREATE TABLE files (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                text NOT NULL,
  mime_type           text NOT NULL DEFAULT 'application/pdf',
  status              file_status NOT NULL DEFAULT 'uploading',
  current_version_id  uuid,                         -- FK added below (circular)
  is_encrypted        boolean NOT NULL DEFAULT false,
  expires_at          timestamptz,                  -- set from plan retention; NULL = keep
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  deleted_at          timestamptz                   -- soft delete; cron removes the bytes
);

CREATE TABLE file_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id      uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  version_no   integer NOT NULL CHECK (version_no > 0),
  source       version_source NOT NULL,
  storage_key  text NOT NULL UNIQUE,                -- e.g. users/{uid}/files/{fid}/v{n}.pdf
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  sha256       text,
  page_count   integer CHECK (page_count >= 0),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, version_no)
);

ALTER TABLE files
  ADD CONSTRAINT files_current_version_fk
  FOREIGN KEY (current_version_id) REFERENCES file_versions(id)
  ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE edit_drafts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id          uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id          uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  base_version_id  uuid NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
  operations       jsonb NOT NULL DEFAULT '[]',     -- annotations, page moves, form values
  revision         integer NOT NULL DEFAULT 1,      -- optimistic locking for autosave
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id, user_id)                         -- one open draft per user per file
);

CREATE TABLE share_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_id     uuid NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_by  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  text NOT NULL UNIQUE,                 -- SHA-256 of the URL token, never the raw token
  permission  share_permission NOT NULL DEFAULT 'view',
  expires_at  timestamptz,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE saved_signatures (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         signature_kind NOT NULL,
  label        text,
  storage_key  text NOT NULL UNIQUE,                -- PNG/SVG in object storage
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- Processing
-- =====================================================================
CREATE TABLE jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type               job_type NOT NULL,
  status             job_status NOT NULL DEFAULT 'queued',
  input_version_id   uuid NOT NULL REFERENCES file_versions(id) ON DELETE CASCADE,
  output_version_id  uuid REFERENCES file_versions(id) ON DELETE SET NULL,  -- new version, or a new file's v1
  options            jsonb NOT NULL DEFAULT '{}',   -- e.g. {"level": "medium", "lang": "eng"}
  queue_message_id   text,                          -- QStash / Inngest id, for tracing
  attempts           integer NOT NULL DEFAULT 0,
  error              text,
  queued_at          timestamptz NOT NULL DEFAULT now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  CONSTRAINT jobs_finish_after_start
    CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at)
);

CREATE TABLE usage_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind         usage_kind NOT NULL,
  quantity     bigint NOT NULL DEFAULT 1 CHECK (quantity > 0),  -- 1 per job; bytes per upload
  job_id       uuid REFERENCES jobs(id) ON DELETE SET NULL,
  occurred_at  timestamptz NOT NULL DEFAULT now()
);

-- =====================================================================
-- Indexes (beyond those created by PRIMARY KEY / UNIQUE)
-- =====================================================================
CREATE INDEX accounts_user_idx        ON accounts (user_id);
CREATE INDEX sessions_user_idx        ON sessions (user_id);
CREATE INDEX sessions_expires_idx     ON sessions (expires_at);

-- At most one live subscription per user
CREATE UNIQUE INDEX subscriptions_one_live_per_user
  ON subscriptions (user_id) WHERE status IN ('trialing', 'active', 'past_due');
CREATE INDEX payments_user_created_idx ON payments (user_id, created_at DESC);
CREATE INDEX webhook_events_unprocessed_idx
  ON webhook_events (received_at) WHERE processed_at IS NULL;

-- Dashboard: "my files", newest first
CREATE INDEX files_owner_recent_idx
  ON files (owner_id, created_at DESC) WHERE deleted_at IS NULL;
-- Cleanup cron: expired or soft-deleted files
CREATE INDEX files_expiry_idx
  ON files (expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX files_deleted_idx
  ON files (deleted_at) WHERE deleted_at IS NOT NULL;

CREATE INDEX edit_drafts_user_idx     ON edit_drafts (user_id);
CREATE INDEX share_links_file_idx     ON share_links (file_id);
CREATE INDEX saved_signatures_user_idx ON saved_signatures (user_id);

CREATE INDEX jobs_user_recent_idx     ON jobs (user_id, queued_at DESC);
CREATE INDEX jobs_input_version_idx   ON jobs (input_version_id);
-- Monitor: queued or stuck jobs
CREATE INDEX jobs_active_idx
  ON jobs (status, queued_at) WHERE status IN ('queued', 'running');

-- Monthly limit check: SUM(quantity) for a user since period start
CREATE INDEX usage_events_user_time_idx ON usage_events (user_id, kind, occurred_at);

-- =====================================================================
-- updated_at triggers
-- =====================================================================
CREATE TRIGGER users_updated_at         BEFORE UPDATE ON users         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER subscriptions_updated_at BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER files_updated_at         BEFORE UPDATE ON files         FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER edit_drafts_updated_at   BEFORE UPDATE ON edit_drafts   FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- =====================================================================
-- Seed: the default plan. Limits below are PLACEHOLDERS; set your own.
-- =====================================================================
INSERT INTO plans (id, name, max_file_mb, monthly_jobs, retention_hours, features)
VALUES ('free', 'Free', 25, 20, 24, '{"ocr": false, "office": false}');
