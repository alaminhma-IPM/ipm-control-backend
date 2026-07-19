-- ═══════════════════════════════════════════════════
-- IPM Control System — Database Schema
-- Run: psql -U postgres -d ipm_control -f schema.sql
-- ═══════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── CLIENTS ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clients (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_name    VARCHAR(200) NOT NULL,
  contact_name    VARCHAR(100),
  email           VARCHAR(200) UNIQUE NOT NULL,
  phone           VARCHAR(30),
  industry        VARCHAR(100),
  country         VARCHAR(80) DEFAULT 'Saudi Arabia',
  username        VARCHAR(60) UNIQUE NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  plan            VARCHAR(30) NOT NULL DEFAULT 'trial',
  status          VARCHAR(20) NOT NULL DEFAULT 'active',
  payment_method  VARCHAR(20) DEFAULT 'manual', -- 'stripe' | 'manual'
  stripe_customer_id VARCHAR(100),
  subscription_id VARCHAR(100),
  trial_ends_at   TIMESTAMPTZ,
  current_period_end TIMESTAMPTZ,
  license_key     VARCHAR(60) UNIQUE NOT NULL,
  max_users       INT DEFAULT 5,
  max_devices     INT DEFAULT 30,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── SUBSCRIPTIONS / PAYMENTS ─────────────────────────
CREATE TABLE IF NOT EXISTS payments (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
  amount          DECIMAL(10,2) NOT NULL,
  currency        VARCHAR(5) DEFAULT 'SAR',
  plan            VARCHAR(30) NOT NULL,
  period_months   INT NOT NULL,
  method          VARCHAR(20) NOT NULL, -- 'stripe' | 'manual'
  stripe_payment_id VARCHAR(200),
  status          VARCHAR(20) DEFAULT 'pending', -- 'pending'|'paid'|'failed'
  invoice_number  VARCHAR(50),
  notes           TEXT,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── INSPECTIONS ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS inspections (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
  device_id       VARCHAR(20) NOT NULL,
  device_type     VARCHAR(100),
  zone            VARCHAR(100),
  status          VARCHAR(20) NOT NULL, -- Good | Not Good | Monitor
  deficiency_type VARCHAR(150),
  notes           TEXT,
  photo_url       TEXT,
  gps_lat         DECIMAL(10,7),
  gps_lng         DECIMAL(10,7),
  inspector       VARCHAR(80),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── CORRECTIVE ACTIONS ───────────────────────────────
CREATE TABLE IF NOT EXISTS corrective_actions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
  inspection_id   UUID REFERENCES inspections(id),
  device_id       VARCHAR(20),
  zone            VARCHAR(100),
  severity        VARCHAR(20) NOT NULL, -- Critical | Medium
  deficiency_type VARCHAR(150) NOT NULL,
  department      VARCHAR(80),
  due_date        TIMESTAMPTZ NOT NULL,
  status          VARCHAR(20) DEFAULT 'Open', -- Open|In Progress|Closed
  resolution_notes TEXT,
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── DEVICES ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS devices (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
  device_id       VARCHAR(20) NOT NULL,
  device_type     VARCHAR(100) NOT NULL,
  zone            VARCHAR(100),
  location        VARCHAR(200),
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, device_id)
);

-- ── AUDIT LOG ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
  username        VARCHAR(80),
  action          VARCHAR(100),
  table_name      VARCHAR(50),
  record_id       UUID,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── INDEXES ──────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_inspections_client ON inspections(client_id);
CREATE INDEX IF NOT EXISTS idx_inspections_created ON inspections(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ca_client ON corrective_actions(client_id);
CREATE INDEX IF NOT EXISTS idx_ca_status ON corrective_actions(status);
CREATE INDEX IF NOT EXISTS idx_devices_client ON devices(client_id);
CREATE INDEX IF NOT EXISTS idx_payments_client ON payments(client_id);

-- ── PLANS VIEW ───────────────────────────────────────
CREATE OR REPLACE VIEW plan_limits AS
SELECT 'trial'        AS plan, 7    AS days, 99    AS price_sar, 5   AS max_users, 30  AS max_devices UNION ALL
SELECT 'basic',                30,           299,               10,               50  UNION ALL
SELECT 'professional',         30,           599,               25,               100 UNION ALL
SELECT 'enterprise',           30,           999,               999,              999;

COMMENT ON TABLE clients IS 'IPM Control — © 2026 Hamid Malik Elamin';
