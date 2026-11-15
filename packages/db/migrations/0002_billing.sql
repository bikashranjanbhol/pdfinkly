-- Billing: the Pro plan, its prices, and how long a user's paid plan lasts.
--
-- users.plan_id + users.plan_expires_at are the fast path for limit checks.
-- They are derived from `subscriptions` (recurring plans and day passes) by
-- the app whenever a payment or webhook changes a subscription; an expired
-- date means the user is back on Free even if no job has run since.

-- A subscription row exists before the first payment (checkout started).
ALTER TYPE subscription_status ADD VALUE IF NOT EXISTS 'incomplete';

ALTER TABLE users ADD COLUMN plan_expires_at timestamptz;

CREATE TABLE prices (
  id                 text PRIMARY KEY,                -- 'pro_month_inr'
  plan_id            text NOT NULL REFERENCES plans(id),
  kind               text NOT NULL CHECK (kind IN ('recurring', 'pass')),
  period             text NOT NULL CHECK (period IN ('day', 'month', 'year')),
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),   -- paise / cents
  currency           char(3) NOT NULL,
  razorpay_plan_ids  jsonb NOT NULL DEFAULT '{}',     -- {"test": "plan_…", "live": "plan_…"}, made on first checkout
  is_active          boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- A day pass is stored as a one-period subscription (kind = 'pass') so the
-- plan's end date is always the latest end among a user's subscriptions.
ALTER TABLE subscriptions
  ADD COLUMN kind text NOT NULL DEFAULT 'recurring' CHECK (kind IN ('recurring', 'pass')),
  ADD COLUMN price_id text REFERENCES prices(id);
CREATE INDEX subscriptions_user_idx ON subscriptions (user_id);
-- Only one live recurring subscription per user; passes can stack beside it.
DROP INDEX subscriptions_one_live_per_user;
CREATE UNIQUE INDEX subscriptions_one_live_per_user
  ON subscriptions (user_id) WHERE status IN ('trialing', 'active', 'past_due') AND kind = 'recurring';

ALTER TABLE payments ADD COLUMN price_id text REFERENCES prices(id);

-- Which browser tool a counted job was (convert, compress …).
ALTER TABLE usage_events ADD COLUMN tool text;

UPDATE plans
SET monthly_jobs = 10,
    features = '{"ocr": true, "redact": false, "protect": false, "bates": false}'
WHERE id = 'free';

INSERT INTO plans (id, name, max_file_mb, monthly_jobs, retention_hours, features)
VALUES ('pro', 'Pro', 200, NULL, NULL, '{"ocr": true, "redact": true, "protect": true, "bates": true}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO prices (id, plan_id, kind, period, amount_minor, currency) VALUES
  ('pro_month_inr', 'pro', 'recurring', 'month', 19900, 'INR'),
  ('pro_year_inr',  'pro', 'recurring', 'year', 149900, 'INR'),
  ('pro_day_inr',   'pro', 'pass',      'day',    4900, 'INR'),
  ('pro_month_usd', 'pro', 'recurring', 'month',   700, 'USD'),
  ('pro_year_usd',  'pro', 'recurring', 'year',   5900, 'USD'),
  ('pro_day_usd',   'pro', 'pass',      'day',     200, 'USD')
ON CONFLICT (id) DO NOTHING;
