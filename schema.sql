-- ═══════════════════════════════════════════════════
-- IPM Control System — Database Schema
-- Run: psql -U postgres -d ipm_control -f schema.sql
--
-- IMPORTANT — read before running against production:
-- This file was reconciled against the live server.js code, which revealed
-- that several tables/columns your app actively queries were NOT present
-- anywhere in the original schema.sql or in server.js's own auto-migration
-- (ensureCompaniesSchema). That means they already exist in your real
-- Railway database (created manually or by a migration not in this repo),
-- but this file didn't know about them. Everything marked "ADDED" below was
-- reconstructed from how server.js actually SELECTs/INSERTs against these
-- tables — types/lengths are reasonable inferences, not confirmed against
-- the live DB. Before relying on this file to provision a fresh environment,
-- diff it against reality with:
--   pg_dump --schema-only -d $DATABASE_URL > live_schema.sql
-- All statements below are IF NOT EXISTS / ADD COLUMN IF NOT EXISTS, so
-- running this against your existing production DB is safe — it will not
-- overwrite or drop anything.
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
  logo_url        TEXT, -- ADDED: referenced throughout server.js (client.logo_url) — base64 data URL, see note at bottom re: object storage migration
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
-- ADDED: role is read as `client.role || 'admin'` in /api/auth/login (server.js ~line 552).
-- The fallback means it's safe even if this column is absent, but adding it removes the
-- silent-fallback ambiguity going forward.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS role VARCHAR(30) DEFAULT 'admin';

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

-- ── COMPANIES (production companies under a pest-control client) ──
-- ADDED: this whole table already existed as an auto-migration inside
-- server.js's ensureCompaniesSchema() function — included here too so a
-- fresh `psql -f schema.sql` produces a complete, working database without
-- depending on first booting the app. IF NOT EXISTS makes running both safe.
CREATE TABLE IF NOT EXISTS companies (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id          UUID REFERENCES clients(id) ON DELETE CASCADE,
  company_name       VARCHAR(200) NOT NULL,
  address            TEXT,
  contact_name       VARCHAR(150),
  contact_phone      VARCHAR(50),
  contact_email      VARCHAR(150),
  industry           VARCHAR(100),
  notes              TEXT,
  team_leader_name   VARCHAR(120),
  team_leader_phone  VARCHAR(60),
  team_leader_email  VARCHAR(160),
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW()
);

-- ── CLIENT USERS (technicians / sub-users, "My Day" role) ──
-- ADDED: queried extensively (client_users cu ... /api/auth/login, /api/client/users)
-- but never CREATE TABLE'd anywhere in the codebase — must already exist live.
-- Columns below are reconstructed from every INSERT/SELECT against it in server.js.
CREATE TABLE IF NOT EXISTS client_users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
  username        VARCHAR(60) NOT NULL,
  password_hash   TEXT NOT NULL,
  full_name       VARCHAR(150),
  role            VARCHAR(30) DEFAULT 'inspector',
  department      VARCHAR(100),
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, username)
);

-- ── COMPANY USERS (production-company portal logins) ──
-- Also part of ensureCompaniesSchema() in server.js; included here for the same
-- "fresh DB from schema.sql alone" reason as `companies` above.
CREATE TABLE IF NOT EXISTS company_users (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  username        VARCHAR(80) NOT NULL,
  password_hash   TEXT NOT NULL,
  full_name       VARCHAR(150),
  email           VARCHAR(150),
  role            VARCHAR(30) DEFAULT 'portal_viewer',
  active          BOOLEAN DEFAULT TRUE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(client_id, username)
);

-- ── USER ↔ COMPANY ASSIGNMENTS (which technicians serve which production company) ──
CREATE TABLE IF NOT EXISTS user_companies (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sub_user_id     UUID REFERENCES client_users(id) ON DELETE CASCADE,
  company_id      UUID REFERENCES companies(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sub_user_id, company_id)
);

-- ── INSPECTION TOURS ("Visits") ──
-- ADDED: never CREATE TABLE'd anywhere — server.js only ever ALTERs it
-- (adding company_id) and assumes the rest already exists. Reconstructed from
-- the INSERT in POST /api/client/tours and the UPDATE in PATCH .../complete.
CREATE TABLE IF NOT EXISTS inspection_tours (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id              UUID REFERENCES clients(id) ON DELETE CASCADE,
  company_id             UUID REFERENCES companies(id) ON DELETE SET NULL,
  tour_name              VARCHAR(200),
  zone                   VARCHAR(100),
  started_by             VARCHAR(120),
  status                 VARCHAR(20) DEFAULT 'in_progress', -- 'in_progress' | 'completed'
  completed_at           TIMESTAMPTZ,
  area_leader_name       VARCHAR(150),
  area_leader_signature  TEXT, -- base64 signature image data
  total_inspections      INT,
  customer_comments      TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
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
-- ADDED: these five columns are used throughout server.js (tour_id links an
-- inspection to inspection_tours; sub_user_id/company_id drive the scoping
-- logic in companyScope(); findings/offline_key back the mobile offline-queue
-- feature) but were absent from the original schema.sql.
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS tour_id      UUID REFERENCES inspection_tours(id) ON DELETE SET NULL;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS sub_user_id  UUID REFERENCES client_users(id) ON DELETE SET NULL;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS company_id   UUID REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS findings     TEXT;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS offline_key  VARCHAR(100); -- dedupe key for offline-queued submissions

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
-- ADDED: used for the same production-company scoping as inspections.company_id.
ALTER TABLE corrective_actions ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;

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
-- ADDED: company_id + the composite unique index below match exactly what
-- server.js's ensureCompaniesSchema() already does at runtime (including
-- dropping the old single-column unique constraint). Included here so a
-- fresh schema.sql run produces the same end state without needing the app
-- to boot first.
ALTER TABLE devices ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_client_id_device_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS devices_client_company_device_uniq
  ON devices (client_id, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), device_id);

-- ── TECHNICIAN APPRAISALS ─────────────────────────────
-- Also part of ensureCompaniesSchema() in server.js; included here for parity.
CREATE TABLE IF NOT EXISTS technician_appraisals (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id              UUID REFERENCES clients(id) ON DELETE CASCADE,
  company_id             UUID REFERENCES companies(id) ON DELETE CASCADE,
  sub_user_id            UUID REFERENCES client_users(id) ON DELETE CASCADE,
  period_label           VARCHAR(40),
  rating                 INTEGER,
  punctuality            INTEGER,
  quality                INTEGER,
  thoroughness           INTEGER,
  communication          INTEGER,
  strengths              TEXT,
  improvements           TEXT,
  comments               TEXT,
  auto_total_inspections INTEGER,
  auto_compliance_rate   INTEGER,
  created_by             VARCHAR(120),
  created_at             TIMESTAMPTZ DEFAULT NOW()
);

-- ── CHEMICAL APPLICATIONS ─────────────────────────────
-- ADDED: never CREATE TABLE'd anywhere. Reconstructed from the INSERT in
-- POST /api/client/chemicals (server.js ~line 981).
CREATE TABLE IF NOT EXISTS chemical_applications (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id           UUID REFERENCES clients(id) ON DELETE CASCADE,
  company_id          UUID REFERENCES companies(id) ON DELETE SET NULL,
  tour_id             UUID REFERENCES inspection_tours(id) ON DELETE SET NULL,
  product             VARCHAR(200),
  registration_no     VARCHAR(100),
  batch_no            VARCHAR(100),
  quantity            VARCHAR(60),
  concentration       VARCHAR(60),
  application_method  VARCHAR(120),
  target_pest         VARCHAR(120),
  treatment_area      VARCHAR(200),
  ppe_used            TEXT,
  weather             VARCHAR(120),
  notes               TEXT,
  applied_by          VARCHAR(120),
  photo_url           TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ── CLIENT CONTRACTS ───────────────────────────────────
-- ADDED: never CREATE TABLE'd anywhere. Reconstructed from the INSERT in
-- POST /api/owner/clients/:id/contracts (server.js ~line 2105).
CREATE TABLE IF NOT EXISTS client_contracts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
  title           VARCHAR(200) NOT NULL,
  file_data       TEXT NOT NULL, -- base64 — see object-storage migration note at bottom
  file_type       VARCHAR(100) DEFAULT 'application/pdf',
  file_name       VARCHAR(255),
  contract_start  DATE,
  contract_end    DATE,
  status          VARCHAR(20) DEFAULT 'active',
  notes           TEXT,
  uploaded_by     VARCHAR(120),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ── CLIENT DOCUMENTS ───────────────────────────────────
-- ADDED: never CREATE TABLE'd anywhere. Reconstructed from the INSERT in
-- POST /api/client/documents (server.js ~line 2163).
CREATE TABLE IF NOT EXISTS client_documents (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
  name            VARCHAR(255) NOT NULL,
  doc_type        VARCHAR(80),
  file_data       TEXT NOT NULL, -- base64 — see object-storage migration note at bottom
  file_type       VARCHAR(100),
  uploaded_by     VARCHAR(120),
  created_at      TIMESTAMPTZ DEFAULT NOW()
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
CREATE INDEX IF NOT EXISTS idx_inspections_client   ON inspections(client_id);
CREATE INDEX IF NOT EXISTS idx_inspections_created  ON inspections(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inspections_tour     ON inspections(tour_id);       -- ADDED
CREATE INDEX IF NOT EXISTS idx_inspections_company  ON inspections(company_id);    -- ADDED
CREATE INDEX IF NOT EXISTS idx_inspections_subuser  ON inspections(sub_user_id);   -- ADDED
CREATE INDEX IF NOT EXISTS idx_ca_client            ON corrective_actions(client_id);
CREATE INDEX IF NOT EXISTS idx_ca_status            ON corrective_actions(status);
CREATE INDEX IF NOT EXISTS idx_ca_company           ON corrective_actions(company_id); -- ADDED
CREATE INDEX IF NOT EXISTS idx_devices_client       ON devices(client_id);
CREATE INDEX IF NOT EXISTS idx_devices_company      ON devices(company_id);        -- ADDED (mirrors ensureCompaniesSchema)
CREATE INDEX IF NOT EXISTS idx_payments_client      ON payments(client_id);
CREATE INDEX IF NOT EXISTS idx_companies_client     ON companies(client_id);       -- ADDED
CREATE INDEX IF NOT EXISTS idx_company_users_company ON company_users(company_id); -- ADDED
CREATE INDEX IF NOT EXISTS idx_company_users_client  ON company_users(client_id);  -- ADDED
CREATE INDEX IF NOT EXISTS idx_usercomp_user        ON user_companies(sub_user_id); -- ADDED
CREATE INDEX IF NOT EXISTS idx_usercomp_company     ON user_companies(company_id);  -- ADDED
CREATE INDEX IF NOT EXISTS idx_tours_company        ON inspection_tours(company_id); -- ADDED
CREATE INDEX IF NOT EXISTS idx_tours_client         ON inspection_tours(client_id);  -- ADDED
CREATE INDEX IF NOT EXISTS idx_appraisals_company   ON technician_appraisals(company_id); -- ADDED
CREATE INDEX IF NOT EXISTS idx_appraisals_subuser   ON technician_appraisals(sub_user_id); -- ADDED
CREATE INDEX IF NOT EXISTS idx_chemicals_client     ON chemical_applications(client_id);   -- ADDED
CREATE INDEX IF NOT EXISTS idx_chemicals_company    ON chemical_applications(company_id);  -- ADDED
CREATE INDEX IF NOT EXISTS idx_contracts_client     ON client_contracts(client_id);        -- ADDED
CREATE INDEX IF NOT EXISTS idx_documents_client     ON client_documents(client_id);        -- ADDED
CREATE INDEX IF NOT EXISTS idx_clientusers_client   ON client_users(client_id);            -- ADDED

-- ── PLANS VIEW ───────────────────────────────────────
CREATE OR REPLACE VIEW plan_limits AS
SELECT 'trial'        AS plan, 7    AS days, 99    AS price_sar, 5   AS max_users, 30  AS max_devices UNION ALL
SELECT 'basic',                30,           299,               10,               50  UNION ALL
SELECT 'professional',         30,           599,               25,               100 UNION ALL
SELECT 'enterprise',           30,           999,               999,              999;

COMMENT ON TABLE clients IS 'IPM Control — © 2026 Hamid Malik Elamin';

-- ═══════════════════════════════════════════════════
-- NOTE — base64-in-database file storage:
-- client_contracts.file_data, client_documents.file_data,
-- inspection_tours.area_leader_signature, and inspections.photo_url all
-- store file content as base64 TEXT directly in Postgres rather than in
-- object storage (S3/Railway volumes/etc). This works but bloats the
-- database and slows backups/queries as usage grows — tracked as a known
-- future improvement, not something this schema update attempts to fix.
-- ═══════════════════════════════════════════════════
