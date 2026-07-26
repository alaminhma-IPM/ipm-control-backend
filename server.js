-- ═══════════════════════════════════════════════════════
-- APQS Technician Module — Migration
-- Run once in Railway PostgreSQL. Safe to re-run (IF NOT EXISTS).
-- ═══════════════════════════════════════════════════════

-- Pest findings stored per inspection (species, counts, evidence)
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS findings JSONB;

-- Offline sync dedupe key (client-generated UUID per submission)
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS offline_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_insp_offline_key
  ON inspections(client_id, offline_key) WHERE offline_key IS NOT NULL;

-- Customer comments on tour completion
ALTER TABLE inspection_tours ADD COLUMN IF NOT EXISTS customer_comments TEXT;

-- Chemical application log
CREATE TABLE IF NOT EXISTS chemical_applications (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id           UUID REFERENCES clients(id) ON DELETE CASCADE,
  tour_id             UUID REFERENCES inspection_tours(id) ON DELETE SET NULL,
  product             VARCHAR(200) NOT NULL,
  registration_no     VARCHAR(100),
  batch_no            VARCHAR(100),
  quantity            VARCHAR(80),
  concentration       VARCHAR(80),
  application_method  VARCHAR(120),
  target_pest         VARCHAR(120),
  treatment_area      VARCHAR(200),
  ppe_used            VARCHAR(200),
  weather             VARCHAR(120),
  notes               TEXT,
  applied_by          VARCHAR(150),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_chem_client ON chemical_applications(client_id);

-- ═══════════════════════════════════════════════════════
-- Data isolation: technicians only see their own work
-- ═══════════════════════════════════════════════════════
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS sub_user_id UUID REFERENCES client_users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_inspections_sub_user ON inspections(sub_user_id);

-- ═══════════════════════════════════════════════════════
-- Chemical application: container photo
-- ═══════════════════════════════════════════════════════
ALTER TABLE chemical_applications ADD COLUMN IF NOT EXISTS photo_url TEXT;

-- ═══════════════════════════════════════════════════════
-- Client branding: company logo (country column already exists)
-- ═══════════════════════════════════════════════════════
ALTER TABLE clients ADD COLUMN IF NOT EXISTS logo_url TEXT;
-- Safety net in case an older DB doesn't have country yet:
ALTER TABLE clients ADD COLUMN IF NOT EXISTS country VARCHAR(80) DEFAULT 'Saudi Arabia';

-- ═══════════════════════════════════════════════════════
-- Client contracts (admin-only upload & view)
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS client_contracts (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
  title           VARCHAR(200) NOT NULL,
  file_data       TEXT NOT NULL,
  file_type       VARCHAR(80) DEFAULT 'application/pdf',
  file_name       VARCHAR(255),
  contract_start  DATE,
  contract_end    DATE,
  status          VARCHAR(20) DEFAULT 'active',
  notes           TEXT,
  uploaded_by     VARCHAR(80),
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contracts_client ON client_contracts(client_id);

-- ═══════════════════════════════════════════════════════
-- Multi-Company Management (customer sites per client account)
-- ═══════════════════════════════════════════════════════
CREATE TABLE IF NOT EXISTS companies (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id       UUID REFERENCES clients(id) ON DELETE CASCADE,
  company_name    VARCHAR(200) NOT NULL,
  address         TEXT,
  contact_name    VARCHAR(150),
  contact_phone   VARCHAR(50),
  contact_email   VARCHAR(150),
  industry        VARCHAR(100),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_companies_client ON companies(client_id);

-- Many-to-many: which technicians (sub-users) can access which companies
-- (supports assigning a primary + backup technician to the same company)
CREATE TABLE IF NOT EXISTS user_companies (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  sub_user_id     UUID REFERENCES client_users(id) ON DELETE CASCADE,
  company_id      UUID REFERENCES companies(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(sub_user_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_usercomp_user ON user_companies(sub_user_id);
CREATE INDEX IF NOT EXISTS idx_usercomp_company ON user_companies(company_id);

-- Devices and Tours now belong to a specific company
ALTER TABLE devices ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
ALTER TABLE inspection_tours ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_devices_company ON devices(company_id);
CREATE INDEX IF NOT EXISTS idx_tours_company ON inspection_tours(company_id);

-- ── MIGRATION: auto-create one company per existing client and ──
-- ── attach all their pre-existing devices/tours to it (safe/idempotent) ──
INSERT INTO companies (client_id, company_name, notes)
SELECT id, company_name, 'Auto-created during Companies feature rollout — contains all devices/tours created before this feature existed.'
FROM clients
WHERE NOT EXISTS (SELECT 1 FROM companies WHERE companies.client_id = clients.id);

UPDATE devices d
SET company_id = c.id
FROM companies c
WHERE d.client_id = c.client_id AND d.company_id IS NULL;

UPDATE inspection_tours t
SET company_id = c.id
FROM companies c
WHERE t.client_id = c.client_id AND t.company_id IS NULL;
