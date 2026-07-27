require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
var PORT = parseInt(process.env.PORT) || 3000;

// ── CORS ─────────────────────────────────────────────
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.json({ limit: '10mb' }));

// ── DATABASE ──────────────────────────────────────────
// Database connection - lazy initialization
var pool = null;

function getPool() {
  if (pool) return pool;
  var dbUrl = process.env.DATABASE_URL
           || process.env.DATABASE_PUBLIC_URL
           || process.env.POSTGRES_URL
           || process.env.POSTGRESQL_URL;

  if (!dbUrl) {
    console.error('NO DATABASE URL SET - add DATABASE_URL to Railway Variables');
    return null;
  }
  try {
    pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
    console.log('Database pool created OK');
    return pool;
  } catch(e) {
    console.error('Database pool error:', e.message);
    return null;
  }
}

// Test DB connection on startup (non-blocking)
setTimeout(function() {
  var p = getPool();
  if (p) {
    p.query('SELECT 1').then(function() {
      console.log('Database connection verified OK');
    }).catch(function(e) {
      console.error('Database connection test failed:', e.message);
    });
  }
}, 2000);


// ── AUTO-MIGRATION: create Companies tables if missing ──
// Runs once on startup so no manual SQL is needed.
async function ensureCompaniesSchema() {
  var p = getPool();
  if (!p) return;
  var steps = [
    "CREATE TABLE IF NOT EXISTS companies (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), client_id UUID REFERENCES clients(id) ON DELETE CASCADE, company_name VARCHAR(200) NOT NULL, address TEXT, contact_name VARCHAR(150), contact_phone VARCHAR(50), contact_email VARCHAR(150), industry VARCHAR(100), notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())",
    "CREATE INDEX IF NOT EXISTS idx_companies_client ON companies(client_id)",
    "CREATE TABLE IF NOT EXISTS user_companies (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), sub_user_id UUID REFERENCES client_users(id) ON DELETE CASCADE, company_id UUID REFERENCES companies(id) ON DELETE CASCADE, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(sub_user_id, company_id))",
    "CREATE INDEX IF NOT EXISTS idx_usercomp_user ON user_companies(sub_user_id)",
    "CREATE INDEX IF NOT EXISTS idx_usercomp_company ON user_companies(company_id)",
    "ALTER TABLE devices ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL",
    "ALTER TABLE inspection_tours ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL",
    "CREATE INDEX IF NOT EXISTS idx_devices_company ON devices(company_id)",
    "CREATE INDEX IF NOT EXISTS idx_tours_company ON inspection_tours(company_id)",
    "DROP INDEX IF EXISTS devices_client_id_device_id_key",
    "ALTER TABLE devices DROP CONSTRAINT IF EXISTS devices_client_id_device_id_key",
    "CREATE UNIQUE INDEX IF NOT EXISTS devices_client_company_device_uniq ON devices (client_id, COALESCE(company_id, '00000000-0000-0000-0000-000000000000'::uuid), device_id)",
    "UPDATE corrective_actions ca SET company_id = i.company_id FROM inspections i WHERE ca.inspection_id = i.id AND i.company_id IS NOT NULL AND (ca.company_id IS NULL OR ca.company_id <> i.company_id)",
    "INSERT INTO companies (client_id, company_name, notes) SELECT id, company_name, 'Auto-created' FROM clients WHERE NOT EXISTS (SELECT 1 FROM companies co WHERE co.client_id = clients.id)",
    "UPDATE devices SET company_id = (SELECT co.id FROM companies co WHERE co.client_id = devices.client_id ORDER BY co.created_at FETCH FIRST ROW ONLY) WHERE company_id IS NULL",
    "UPDATE inspection_tours SET company_id = (SELECT co.id FROM companies co WHERE co.client_id = inspection_tours.client_id ORDER BY co.created_at FETCH FIRST ROW ONLY) WHERE company_id IS NULL",
    "CREATE TABLE IF NOT EXISTS company_users (id UUID PRIMARY KEY DEFAULT uuid_generate_v4(), company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE, client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE, username VARCHAR(80) NOT NULL, password_hash TEXT NOT NULL, full_name VARCHAR(150), email VARCHAR(150), role VARCHAR(30) DEFAULT 'portal_viewer', active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(client_id, username))",
    "CREATE INDEX IF NOT EXISTS idx_company_users_company ON company_users(company_id)",
    "CREATE INDEX IF NOT EXISTS idx_company_users_client ON company_users(client_id)"
  ];
  for (var i = 0; i < steps.length; i++) {
    try {
      await p.query(steps[i]);
    } catch(e) {
      console.error('Auto-migration step ' + (i+1) + ' skipped: ' + e.message);
    }
  }
  console.log('Companies schema check complete');
}

// Run auto-migration shortly after startup
setTimeout(function() {
  ensureCompaniesSchema().catch(function(e) {
    console.error('Auto-migration error:', e.message);
  });
}, 4000);

// ── CONSTANTS ─────────────────────────────────────────
var PLANS = {
  trial:        { days: 3,   price: 0,   max_users: 5,   max_devices: 30  },
  basic:        { days: 30,  price: 299,  max_users: 10,  max_devices: 50  },
  professional: { days: 30,  price: 599,  max_users: 25,  max_devices: 100 },
  enterprise:   { days: 30,  price: 999,  max_users: 999, max_devices: 999 }
};

var DEVICE_SEED = [
  { id:'D-0001', type:'Rodent Bait Station',       zone:'Zone A - Cold Storage',  location:'Near entrance door' },
  { id:'D-0002', type:'Rodent Glue Board',          zone:'Zone B - Packaging',     location:'Under conveyor line 1' },
  { id:'D-0003', type:'Rodent Snap Trap',           zone:'Zone C - Processing',    location:'Wall mount south' },
  { id:'D-0004', type:'Rodent Bait Station',        zone:'Zone D - Warehouse',     location:'Corner NW' },
  { id:'D-0005', type:'Rodent Bait Station',        zone:'Perimeter NE',           location:'External north wall' },
  { id:'D-0006', type:'Cockroach Glue Trap',        zone:'Zone A - Cold Storage',  location:'Behind refrigeration units' },
  { id:'D-0007', type:'Cockroach Bait Station',     zone:'Zone B - Packaging',     location:'Under equipment cabinets' },
  { id:'D-0008', type:'Cockroach Glue Trap',        zone:'Zone C - Processing',    location:'Floor drain area' },
  { id:'D-0009', type:'Cockroach Bait Station',     zone:'Zone D - Warehouse',     location:'Pallet storage corners' },
  { id:'D-0010', type:'Fly Trap - UV Light',        zone:'Zone A - Cold Storage',  location:'Ceiling mount NE corner' },
  { id:'D-0011', type:'Fly Kit',                    zone:'Zone C - Processing',    location:'Above prep area' },
  { id:'D-0012', type:'Fly Kit',                    zone:'Zone D - Warehouse',     location:'Loading dock' },
  { id:'D-0013', type:'Air Curtain',                zone:'Zone B - Packaging',     location:'Main door' },
  { id:'D-0014', type:'Fly Glue Board',             zone:'Main Entrance',          location:'Reception area' },
  { id:'D-0015', type:'Ant Bait Station',           zone:'Zone A - Cold Storage',  location:'Wall perimeter east' },
  { id:'D-0016', type:'Ant Bait Station',           zone:'Zone B - Packaging',     location:'Near water lines' },
  { id:'D-0017', type:'Ant Glue Trap',              zone:'Zone C - Processing',    location:'Equipment base areas' },
  { id:'D-0018', type:'Mosquito Trap - CO2',        zone:'Perimeter NE',           location:'External east wall' },
  { id:'D-0019', type:'Mosquito UV Trap',           zone:'Main Entrance',          location:'Above entrance canopy' },
  { id:'D-0020', type:'Mosquito Larvicide Station', zone:'Perimeter NE',           location:'Drainage area north' },
  { id:'D-0021', type:'Pheromone Trap - SPI',       zone:'Zone D - Warehouse',     location:'Grain storage area NW' },
  { id:'D-0022', type:'Pheromone Trap - SPI',       zone:'Zone D - Warehouse',     location:'Grain storage area SE' },
  { id:'D-0023', type:'Stored Product Insect Trap', zone:'Zone C - Processing',    location:'Raw material intake' },
  { id:'D-0024', type:'SPI Monitoring Trap',        zone:'Zone A - Cold Storage',  location:'Dry goods storage' },
  { id:'D-0025', type:'Bird Net - Exclusion',       zone:'Zone D - Warehouse',     location:'Loading dock roof' },
  { id:'D-0026', type:'Bird Spike Strip',           zone:'Perimeter NE',           location:'Roof ledge north' },
  { id:'D-0027', type:'Bird Deterrent - Sonic',     zone:'Main Entrance',          location:'External canopy' },
  { id:'D-0028', type:'Bird Wire System',           zone:'Zone B - Packaging',     location:'Roof beam structure' }
];

var DEFICIENCY_RULES = {
  'Rodent Activity - Live Sighting':    { sev:'Critical', dept:'Pest Tech',   h:24 },
  'Rodent Activity - Droppings':        { sev:'Critical', dept:'Pest Tech',   h:24 },
  'Rodent Activity - Gnaw Marks':       { sev:'Critical', dept:'Pest Tech',   h:24 },
  'Rodent Trap Triggered':              { sev:'Critical', dept:'Pest Tech',   h:24 },
  'Bait Consumed - Rodent':             { sev:'Critical', dept:'Maintenance', h:24 },
  'Bait Consumed':                      { sev:'Critical', dept:'Maintenance', h:24 },
  'Cockroach Activity - Live Sighting': { sev:'Critical', dept:'Pest Tech',   h:24 },
  'Cockroach Activity - Egg Cases':     { sev:'Critical', dept:'Pest Tech',   h:24 },
  'Bait Consumed - Cockroach':          { sev:'Critical', dept:'Pest Tech',   h:24 },
  'SPI Infestation in Product':         { sev:'Critical', dept:'Pest Tech',   h:24 },
  'Door Gap':                           { sev:'Critical', dept:'Maintenance', h:24 },
  'Wall Crack':                         { sev:'Critical', dept:'Maintenance', h:24 },
  'Bird Entry Point Found':             { sev:'Critical', dept:'Maintenance', h:24 }
};
var DEFAULT_RULE = { sev:'Medium', dept:'Pest Tech', h:72 };

// ── HELPERS ───────────────────────────────────────────
function genLicense(name) {
  var safe = name.replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0,4);
  while (safe.length < 4) safe += 'X';
  return 'IPM-' + safe + '-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
}


// ── PASSWORD STRENGTH CHECK ───────────────────────────
function checkPasswordStrength(pw) {
  if (!pw || pw.length < 8) return 'Password must be at least 8 characters';
  if (!/[A-Z]/.test(pw)) return 'Password must contain an uppercase letter';
  if (!/[a-z]/.test(pw)) return 'Password must contain a lowercase letter';
  if (!/[0-9]/.test(pw)) return 'Password must contain a number';
  return null;
}


// ── RBAC: block technicians (sub-users) from admin actions ──
function mainAccountOnly(req, res, next) {
  if (req.user && req.user.user_type === 'sub_user') {
    return res.status(403).json({ error: 'Technicians cannot perform this action. Contact your account administrator.' });
  }
  next();
}


// ── COMPANY SCOPING ───────────────────────────────────
// Production Company accounts are hard-scoped to their own company_id.
// Returns the company_id to filter by, or null for pest-control accounts.
function companyScope(req) {
  return (req.user && req.user.user_type === 'company_account') ? req.user.company_id : null;
}

// Blocks production-company accounts from pest-control-only features
function pestControlOnly(req, res, next) {
  if (req.user && req.user.user_type === 'company_account') {
    return res.status(403).json({ error: 'Not available for production company accounts' });
  }
  next();
}

function authMiddleware(req, res, next) {
  var header = req.headers.authorization || '';
  var token = header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    var secret = process.env.JWT_SECRET || 'IPMControl2026DefaultSecret';
    req.user = jwt.verify(token, secret);
    next();
  } catch(e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function ownerMiddleware(req, res, next) {
  var header = req.headers.authorization || '';
  var token = header.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    var secret = process.env.JWT_SECRET || 'IPMControl2026DefaultSecret';
    var decoded = jwt.verify(token, secret);
    if (decoded.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    req.user = decoded;
    next();
  } catch(e) {
    res.status(401).json({ error: 'Invalid token' });
  }
}

// ── HEALTH ────────────────────────────────────────────
app.get('/api/health', function(req, res) {
  res.json({ status: 'ok', time: new Date(), system: 'IPM Control 2026 - Hamid Malik Elamin' });
});

// ── ENV DEBUG ─────────────────────────────────────────
app.get('/api/debug/env', function(req, res) {
  var email = process.env.OWNER_EMAIL || 'NOT_SET';
  var pass  = process.env.OWNER_PASSWORD || 'NOT_SET';
  var jwts  = process.env.JWT_SECRET || 'NOT_SET';
  var db      = process.env.DATABASE_URL         || 'NOT_SET';
  var dbpub   = process.env.DATABASE_PUBLIC_URL   || 'NOT_SET';
  var dbpost  = process.env.POSTGRES_URL          || 'NOT_SET';
  res.json({
    OWNER_EMAIL:           email,
    OWNER_EMAIL_LENGTH:    email.length,
    OWNER_PASSWORD:        pass === 'NOT_SET' ? 'NOT_SET' : '*'.repeat(pass.length),
    OWNER_PASSWORD_LENGTH: pass.length,
    JWT_SECRET:            jwts === 'NOT_SET' ? 'NOT_SET' : 'SET_(' + jwts.length + '_chars)',
    DATABASE_URL:          db     === 'NOT_SET' ? 'NOT_SET' : 'SET',
    DATABASE_PUBLIC_URL:   dbpub  === 'NOT_SET' ? 'NOT_SET' : 'SET',
    POSTGRES_URL:          dbpost === 'NOT_SET' ? 'NOT_SET' : 'SET',
    NODE_ENV:              process.env.NODE_ENV || 'NOT_SET',
    PORT:                  process.env.PORT     || 'NOT_SET',
    ACTIVE_DB:             (db!=='NOT_SET'?'DATABASE_URL':dbpub!=='NOT_SET'?'DATABASE_PUBLIC_URL':dbpost!=='NOT_SET'?'POSTGRES_URL':'NONE_SET')
  });
});

// ── OWNER LOGIN ───────────────────────────────────────
app.post('/api/owner/login', function(req, res) {
  var email    = (req.body.email    || '').trim().toLowerCase();
  var password = (req.body.password || '').trim();
  var envEmail = (process.env.OWNER_EMAIL    || '').trim().toLowerCase();
  var envPass  = (process.env.OWNER_PASSWORD || '').trim();
  var secret   = process.env.JWT_SECRET || 'IPMControl2026DefaultSecret';

  console.log('Owner login attempt:', email);
  console.log('OWNER_EMAIL set:', envEmail ? 'yes ('+envEmail.length+' chars)' : 'NO');
  console.log('OWNER_PASSWORD set:', envPass ? 'yes ('+envPass.length+' chars)' : 'NO');

  if (!envEmail || !envPass) {
    return res.status(500).json({
      error: 'Server config error: OWNER_EMAIL or OWNER_PASSWORD not set in Railway Variables'
    });
  }
  if (email !== envEmail || password !== envPass) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  try {
    var token = jwt.sign({ role:'owner', email: email }, secret, { expiresIn:'12h' });
    res.json({ token: token, role: 'owner' });
  } catch(e) {
    res.status(500).json({ error: 'Token error: ' + e.message });
  }
});

// ── OWNER: GET ALL CLIENTS ────────────────────────────
app.get('/api/owner/clients', ownerMiddleware, async function(req, res) {
  try {
    var p = getPool(); if(!p) return res.status(500).json({error:"Database not configured. Add DATABASE_URL to Railway Variables"});
    var result = await p.query(
      'SELECT c.*, ' +
      '(SELECT COUNT(*) FROM inspections i WHERE i.client_id=c.id) AS total_inspections, ' +
      '(SELECT COUNT(*) FROM corrective_actions ca WHERE ca.client_id=c.id AND ca.status=\'Open\') AS open_cas, ' +
      '(SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.client_id=c.id AND p.status=\'paid\') AS total_paid ' +
      'FROM clients c ORDER BY c.created_at DESC'
    );
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── OWNER: CREATE CLIENT ──────────────────────────────
app.post('/api/owner/clients', ownerMiddleware, async function(req, res) {
  var b = req.body;
  if (!b.company_name || !b.email || !b.username || !b.password || !b.plan)
    return res.status(400).json({ error: 'Missing required fields' });

  var planCfg = PLANS[b.plan];
  if (!planCfg) return res.status(400).json({ error: 'Invalid plan' });

  var pwErrC = checkPasswordStrength(b.password);
  if (pwErrC) return res.status(400).json({ error: pwErrC });

  try {
    var hash    = await bcrypt.hash(b.password, 10);
    var lic     = genLicense(b.company_name);
    var expires = new Date(Date.now() + planCfg.days * 86400000);

    var p = getPool(); if(!p) return res.status(500).json({error:"Database not configured. Add DATABASE_URL to Railway Variables"});
    var result = await p.query(
      'INSERT INTO clients (company_name,contact_name,email,phone,industry,country,username,password_hash,plan,payment_method,license_key,max_users,max_devices,current_period_end,notes,logo_url) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
      [b.company_name, b.contact_name||'', b.email, b.phone||'', b.industry||'', b.country||'Saudi Arabia',
       b.username, hash, b.plan, b.payment_method||'manual',
       lic, (parseInt(b.max_users) > 0 ? parseInt(b.max_users) : planCfg.max_users), planCfg.max_devices, expires, b.notes||'', b.logo_url||null]
    );
    var client = result.rows[0];

    for (var i = 0; i < DEVICE_SEED.length; i++) {
      var d = DEVICE_SEED[i];
      await getPool().query(
        'INSERT INTO devices (client_id,device_id,device_type,zone,location) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
        [client.id, d.id, d.type, d.zone, d.location]
      );
    }

    res.json({ client: client, license_key: lic });
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Username or email already exists' });
    res.status(500).json({ error: e.message });
  }
});

// ── OWNER: RENEW CLIENT ───────────────────────────────
app.patch('/api/owner/clients/:id/renew', ownerMiddleware, async function(req, res) {
  var days = parseInt(req.body.days) || 30;
  var plan = req.body.plan;
  try {
    var sql = 'UPDATE clients SET current_period_end = GREATEST(current_period_end, NOW()) + INTERVAL \'' + days + ' days\', updated_at=NOW()';
    if (plan && PLANS[plan]) {
      sql += ', plan=\'' + plan + '\', max_users=' + PLANS[plan].max_users + ', max_devices=' + PLANS[plan].max_devices;
    }
    sql += ' WHERE id=$1 RETURNING *';
    var p = getPool(); if(!p) return res.status(500).json({error:"Database not configured. Add DATABASE_URL to Railway Variables"});
    var result = await p.query(sql, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── OWNER: DELETE CLIENT ──────────────────────────────
app.delete('/api/owner/clients/:id', ownerMiddleware, async function(req, res) {
  try {
    await getPool().query('DELETE FROM clients WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── OWNER: STATS ──────────────────────────────────────
app.get('/api/owner/stats', ownerMiddleware, async function(req, res) {
  try {
    var p = getPool(); if(!p) return res.status(500).json({error:"Database not configured"});
    var c = await p.query('SELECT COUNT(*) AS total, COUNT(*) FILTER(WHERE status=\'active\') AS active, COUNT(*) FILTER(WHERE current_period_end < NOW()) AS expired FROM clients');
    var r = await p.query('SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM payments WHERE status=\'paid\'');
    var i = await p.query('SELECT COUNT(*) AS total FROM inspections WHERE created_at > NOW()-INTERVAL \'30 days\'');
    var a = await p.query('SELECT COUNT(*) AS open FROM corrective_actions WHERE status=\'Open\'');
    res.json({ clients: c.rows[0], revenue: r.rows[0], inspections: i.rows[0], cas: a.rows[0] });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── OWNER: RECORD PAYMENT ─────────────────────────────
app.post('/api/owner/payments', ownerMiddleware, async function(req, res) {
  var b = req.body;
  var inv = 'INV-' + Date.now().toString(36).toUpperCase();
  try {
    var p = getPool(); if(!p) return res.status(500).json({error:"Database not configured. Add DATABASE_URL to Railway Variables"});
    var result = await p.query(
      'INSERT INTO payments (client_id,amount,currency,plan,period_months,method,status,invoice_number,notes,paid_at) VALUES ($1,$2,\'SAR\',$3,$4,\'manual\',\'paid\',$5,$6,NOW()) RETURNING *',
      [b.client_id, b.amount, b.plan, b.period_months||1, inv, b.notes||'']
    );
    var months = b.period_months || 1;
    await getPool().query(
      'UPDATE clients SET current_period_end=GREATEST(current_period_end,NOW())+INTERVAL \'' + (months*30) + ' days\', plan=$1, updated_at=NOW() WHERE id=$2',
      [b.plan, b.client_id]
    );
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── OWNER: VIEW CLIENT USERS ──────────────────────
app.get('/api/owner/client-users/:id', ownerMiddleware, async function(req, res) {
  try {
    var p = getPool();
    var result = await p.query(
      'SELECT id,username,full_name,role,department,active,created_at FROM client_users WHERE client_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── OWNER: GET CLIENT STATS WITH USER COUNT ────────
// ── OWNER: GET PAYMENTS ───────────────────────────────
app.get('/api/owner/payments', ownerMiddleware, async function(req, res) {
  try {
    var p = getPool(); if(!p) return res.status(500).json({error:"Database not configured. Add DATABASE_URL to Railway Variables"});
    var result = await p.query(
      'SELECT p.*, c.company_name FROM payments p JOIN clients c ON c.id=p.client_id ORDER BY p.created_at DESC LIMIT 100'
    );
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENT LOGIN ──────────────────────────────────────
app.post('/api/auth/login', async function(req, res) {
  var username = (req.body.username || '').trim();
  var password = req.body.password || '';
  var secret = process.env.JWT_SECRET || 'IPMControl2026DefaultSecret';
  try {
    var p = getPool();
    if (!p) return res.status(500).json({ error: 'Database not configured' });

    // 1. Check main clients table
    var result = await p.query('SELECT * FROM clients WHERE username=$1', [username]);
    if (result.rows.length) {
      var client = result.rows[0];
      var valid = await bcrypt.compare(password, client.password_hash);
      if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
      if (client.status !== 'active') return res.status(403).json({ error: 'Account suspended' });
      var days = Math.ceil((new Date(client.current_period_end) - new Date()) / 86400000);
      var token = jwt.sign(
        { id: client.id, username: client.username, role: client.role || 'admin', plan: client.plan, expired: days <= 0, user_type: 'client_main' },
        secret, { expiresIn: '24h' }
      );
      var safe = Object.assign({}, client);
      delete safe.password_hash;
      return res.json({ token: token, client: safe, expired: days <= 0 });
    }

    // 2b. Check company_users table (production company portal — read-only)
    try {
      var cuTableCheck = await p.query("SELECT to_regclass('public.company_users') AS t");
      if (cuTableCheck.rows[0].t) {
        var portalResult = await p.query(
          'SELECT pu.*, co.company_name AS production_company_name, co.id AS production_company_id, ' +
          'c.company_name AS pest_control_company_name, c.plan, c.current_period_end, c.status AS client_status, c.logo_url ' +
          'FROM company_users pu ' +
          'JOIN companies co ON co.id = pu.company_id ' +
          'JOIN clients c ON c.id = pu.client_id ' +
          'WHERE pu.username=$1 AND pu.active=TRUE', [username]
        );
        if (portalResult.rows.length) {
          var pu = portalResult.rows[0];
          var validPortal = await bcrypt.compare(password, pu.password_hash);
          if (validPortal) {
            if (pu.client_status !== 'active') return res.status(403).json({ error: 'Account suspended' });
            var daysLeftPortal = Math.ceil((new Date(pu.current_period_end) - new Date()) / 86400000);
            var portalToken = jwt.sign(
              { id: pu.client_id, username: pu.username, role: 'company_admin',
                plan: pu.plan, expired: daysLeftPortal <= 0, user_type: 'company_account',
                portal_user_id: pu.id, company_id: pu.production_company_id,
                full_name: pu.full_name },
              secret, { expiresIn: '24h' }
            );
            return res.json({
              token: portalToken,
              client: {
                id: pu.client_id,
                username: pu.username,
                company_name: pu.production_company_name,
                pest_control_company_name: pu.pest_control_company_name,
                plan: pu.plan,
                current_period_end: pu.current_period_end,
                user_type: 'company_account',
                is_company_account: true,
                company_id: pu.production_company_id,
                full_name: pu.full_name,
                logo_url: pu.logo_url
              },
              expired: daysLeftPortal <= 0
            });
          }
        }
      }
    } catch(portalErr) { /* company_users table may not exist yet */ }

    // 2. Check client_users table (technicians added by clients)
    var userResult = await p.query(
      'SELECT cu.*, c.company_name, c.plan, c.current_period_end, c.status AS client_status, c.license_key, c.logo_url, c.country ' +
      'FROM client_users cu JOIN clients c ON c.id = cu.client_id ' +
      'WHERE cu.username=$1 AND cu.active=TRUE', [username]
    );
    if (!userResult.rows.length) return res.status(401).json({ error: 'Invalid credentials' });

    var user = userResult.rows[0];
    var validUser = await bcrypt.compare(password, user.password_hash);
    if (!validUser) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.client_status !== 'active') return res.status(403).json({ error: 'Account suspended' });

    var daysLeft = Math.ceil((new Date(user.current_period_end) - new Date()) / 86400000);
    var userToken = jwt.sign(
      { id: user.client_id, username: user.username, role: user.role || 'inspector',
        plan: user.plan, expired: daysLeft <= 0, user_type: 'sub_user',
        sub_user_id: user.id, full_name: user.full_name },
      secret, { expiresIn: '24h' }
    );

    return res.json({
      token: userToken,
      client: {
        id: user.client_id,
        username: user.username,
        company_name: user.company_name,
        plan: user.plan,
        current_period_end: user.current_period_end,
        license_key: user.license_key,
        role: user.role,
        full_name: user.full_name,
        department: user.department,
        user_type: 'sub_user',
        logo_url: user.logo_url,
        country: user.country
      },
      expired: daysLeft <= 0
    });

  } catch(e) {
    console.error('Login error:', e.message);
    res.status(500).json({ error: 'Login failed: ' + e.message });
  }
});

// ── CLIENT: ME ────────────────────────────────────────
app.get('/api/client/me', authMiddleware, async function(req, res) {
  try {
    var p = getPool(); if(!p) return res.status(500).json({error:"Database not configured. Add DATABASE_URL to Railway Variables"});
    // Production company account: return their company context, not the pest control company
    if (req.user.user_type === 'company_account') {
      var coRes = await p.query(
        'SELECT co.company_name AS production_company_name, co.id AS company_id, ' +
        'c.plan, c.current_period_end, c.status AS client_status, c.logo_url, ' +
        'pu.username, pu.full_name ' +
        'FROM company_users pu ' +
        'JOIN companies co ON co.id = pu.company_id ' +
        'JOIN clients c ON c.id = pu.client_id ' +
        'WHERE pu.id=$1', [req.user.portal_user_id]
      );
      if (!coRes.rows.length) return res.status(404).json({ error: 'Not found' });
      var co = coRes.rows[0];
      var daysC = Math.ceil((new Date(co.current_period_end) - new Date()) / 86400000);
      return res.json({
        id: req.user.id, username: co.username, full_name: co.full_name,
        company_name: co.production_company_name, company_id: co.company_id,
        plan: co.plan, current_period_end: co.current_period_end, logo_url: co.logo_url,
        user_type: 'company_account', is_company_account: true,
        days_left: daysC, expired: daysC <= 0
      });
    }
    var result = await p.query('SELECT * FROM clients WHERE id=$1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    var safe = Object.assign({}, result.rows[0]);
    delete safe.password_hash;
    if (req.user.user_type === 'sub_user') {
      safe.user_type = 'sub_user'; safe.sub_user_id = req.user.sub_user_id;
      safe.full_name = req.user.full_name || safe.full_name; safe.role = req.user.role || safe.role;
    }
    var days = Math.ceil((new Date(safe.current_period_end) - new Date()) / 86400000);
    res.json(Object.assign(safe, { days_left: days, expired: days <= 0 }));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENT: DEVICES ───────────────────────────────────
app.get('/api/client/devices', authMiddleware, async function(req, res) {
  try {
    var p = getPool(); if(!p) return res.status(500).json({error:"Database not configured. Add DATABASE_URL to Railway Variables"});
    var result;
    var coDev = companyScope(req);
    if (coDev) {
      result = await p.query(
        'SELECT * FROM devices WHERE client_id=$1 AND company_id=$2 AND active=TRUE ORDER BY device_id',
        [req.user.id, coDev]
      );
      return res.json(result.rows);
    }
    if (req.user.user_type === 'sub_user') {
      // Technicians only see devices belonging to companies they're assigned to
      try {
        result = await p.query(
          'SELECT DISTINCT d.* FROM devices d ' +
          'JOIN user_companies uc ON uc.company_id = d.company_id ' +
          'WHERE d.client_id=$1 AND d.active=TRUE AND uc.sub_user_id=$2 ' +
          (req.query.company_id ? 'AND d.company_id=$3 ' : '') +
          'ORDER BY d.device_id',
          req.query.company_id ? [req.user.id, req.user.sub_user_id, req.query.company_id] : [req.user.id, req.user.sub_user_id]
        );
      } catch(joinErr) {
        // Fallback if companies tables are not set up yet — show all client devices
        result = await p.query(
          'SELECT * FROM devices WHERE client_id=$1 AND active=TRUE ORDER BY device_id',
          [req.user.id]
        );
      }
    } else if (req.query.company_id) {
      result = await p.query(
        'SELECT * FROM devices WHERE client_id=$1 AND active=TRUE AND company_id=$2 ORDER BY device_id',
        [req.user.id, req.query.company_id]
      );
    } else {
      result = await p.query(
        'SELECT * FROM devices WHERE client_id=$1 AND active=TRUE ORDER BY device_id',
        [req.user.id]
      );
    }
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});



// ── CLIENT: DELETE ALL DEVICES (reset before new batch) ──
app.delete('/api/client/devices/all', authMiddleware, mainAccountOnly, async function(req, res) {
  try {
    var p = getPool();
    var result = await p.query(
      'DELETE FROM devices WHERE client_id=$1',
      [req.user.id]
    );
    res.json({ ok: true, deleted: result.rowCount });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENT: DELETE SINGLE DEVICE ──────────────────────
app.delete('/api/client/devices/:id', authMiddleware, mainAccountOnly, async function(req, res) {
  try {
    var p = getPool();
    await p.query(
      'DELETE FROM devices WHERE id=$1 AND client_id=$2',
      [req.params.id, req.user.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENT: INSPECTION TOURS + SIGNATURES ─────────────
// GET all tours
app.get('/api/client/tours', authMiddleware, async function(req, res) {
  try {
    var p = getPool();
    var result;
    var coTours = companyScope(req);
    if (coTours) {
      result = await p.query(
        'SELECT t.*, (SELECT COUNT(*) FROM inspections i WHERE i.tour_id = t.id) AS live_inspection_count ' +
        'FROM inspection_tours t WHERE t.client_id=$1 AND t.company_id=$2 ORDER BY t.created_at DESC LIMIT 100',
        [req.user.id, coTours]
      );
      result.rows.forEach(function(r) { r.total_inspections = parseInt(r.live_inspection_count) || 0; });
      return res.json(result.rows);
    }
    if (req.user.user_type === 'sub_user') {
      // Technicians see tours they started, contributed to, OR that belong to a company they're assigned to
      try {
        result = await p.query(
          'SELECT DISTINCT t.*, (SELECT COUNT(*) FROM inspections i WHERE i.tour_id = t.id) AS live_inspection_count ' +
          'FROM inspection_tours t ' +
          'LEFT JOIN user_companies uc ON uc.company_id = t.company_id AND uc.sub_user_id=$3 ' +
          'WHERE t.client_id=$1 AND ' +
          '(t.started_by=$2 OR EXISTS (SELECT 1 FROM inspections i WHERE i.tour_id = t.id AND i.sub_user_id=$3) OR uc.id IS NOT NULL) ' +
          'ORDER BY t.created_at DESC LIMIT 100',
          [req.user.id, req.user.username, req.user.sub_user_id]
        );
      } catch(joinErr2) {
        result = await p.query(
          'SELECT t.*, (SELECT COUNT(*) FROM inspections i WHERE i.tour_id = t.id) AS live_inspection_count ' +
          'FROM inspection_tours t WHERE t.client_id=$1 AND ' +
          '(t.started_by=$2 OR EXISTS (SELECT 1 FROM inspections i WHERE i.tour_id = t.id AND i.sub_user_id=$3)) ' +
          'ORDER BY t.created_at DESC LIMIT 100',
          [req.user.id, req.user.username, req.user.sub_user_id]
        );
      }
    } else {
      result = await p.query(
        'SELECT t.*, (SELECT COUNT(*) FROM inspections i WHERE i.tour_id = t.id) AS live_inspection_count ' +
        'FROM inspection_tours t WHERE t.client_id=$1 ORDER BY t.created_at DESC LIMIT 100',
        [req.user.id]
      );
    }
    result.rows.forEach(function(r) { r.total_inspections = parseInt(r.live_inspection_count) || 0; });
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET single tour with inspections
app.get('/api/client/tours/:id', authMiddleware, async function(req, res) {
  try {
    var p = getPool();
    var tour = await p.query(
      "SELECT * FROM inspection_tours WHERE id=$1 AND client_id=$2",
      [req.params.id, req.user.id]
    );
    if (!tour.rows.length) return res.status(404).json({ error: 'Tour not found' });
    if (req.user.user_type === 'sub_user') {
      var access = await p.query(
        'SELECT 1 FROM inspections WHERE tour_id=$1 AND sub_user_id=$2 LIMIT 1',
        [req.params.id, req.user.sub_user_id]
      );
      var companyAccess = await p.query(
        'SELECT 1 FROM user_companies WHERE company_id=$1 AND sub_user_id=$2 LIMIT 1',
        [tour.rows[0].company_id, req.user.sub_user_id]
      );
      var isStarter = tour.rows[0].started_by === req.user.username;
      if (!access.rows.length && !isStarter && !companyAccess.rows.length) {
        return res.status(403).json({ error: 'You do not have access to this tour' });
      }
      // Show only their own inspections within the tour
      var insps2 = await p.query(
        "SELECT * FROM inspections WHERE tour_id=$1 AND sub_user_id=$2 ORDER BY created_at",
        [req.params.id, req.user.sub_user_id]
      );
      return res.json({ tour: tour.rows[0], inspections: insps2.rows });
    }
    var insps = await p.query(
      "SELECT * FROM inspections WHERE tour_id=$1 ORDER BY created_at",
      [req.params.id]
    );
    res.json({ tour: tour.rows[0], inspections: insps.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST create new tour (start)
app.post('/api/client/tours', authMiddleware, async function(req, res) {
  var b = req.body;
  try {
    var p = getPool();
    // Company accounts always create tours for their own facility
    var coTourPost = companyScope(req);
    if (coTourPost) b.company_id = coTourPost;
    // If company_id provided, verify it exists; if not (old clients), allow tour without company
    if (b.company_id) {
      var tableCheck2 = await p.query("SELECT to_regclass('public.companies') AS t");
      if (tableCheck2.rows[0].t) {
        var comp = await p.query('SELECT id, company_name FROM companies WHERE id=$1 AND client_id=$2', [b.company_id, req.user.id]);
        if (!comp.rows.length) return res.status(404).json({ error: 'Company not found' });
      }
    }
    // Technicians can only start a tour for a company they're assigned to
    if (req.user.user_type === 'sub_user') {
      var access = await p.query('SELECT 1 FROM user_companies WHERE company_id=$1 AND sub_user_id=$2', [b.company_id, req.user.sub_user_id]);
      if (!access.rows.length) return res.status(403).json({ error: 'You are not assigned to this company' });
    }
    var tourCompanyId = b.company_id || null;
    var result;
    try {
      result = await p.query(
        "INSERT INTO inspection_tours (client_id, tour_name, zone, started_by, status, company_id) VALUES ($1,$2,$3,$4,'in_progress',$5) RETURNING *",
        [req.user.id, b.tour_name||'Plant Inspection Tour', b.zone||'', b.started_by||req.user.username, tourCompanyId]
      );
    } catch(colErr) {
      // Fallback if company_id column doesn't exist yet
      result = await p.query(
        "INSERT INTO inspection_tours (client_id, tour_name, zone, started_by, status) VALUES ($1,$2,$3,$4,'in_progress') RETURNING *",
        [req.user.id, b.tour_name||'Plant Inspection Tour', b.zone||'', b.started_by||req.user.username]
      );
    }
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH complete tour + capture signature
app.patch('/api/client/tours/:id/complete', authMiddleware, async function(req, res) {
  var b = req.body;
  if (!b.signature_data) return res.status(400).json({ error: 'signature_data is required' });
  try {
    var p = getPool();
    // Get tour inspection count
    var count = await p.query("SELECT COUNT(*) AS cnt FROM inspections WHERE tour_id=$1", [req.params.id]);
    var result = await p.query(
      "UPDATE inspection_tours SET status=$1, completed_at=NOW(), area_leader_name=$2, area_leader_signature=$3, total_inspections=$4, customer_comments=$5, updated_at=NOW() WHERE id=$6 AND client_id=$7 RETURNING *",
      ['completed', b.area_leader_name||'', b.signature_data, parseInt(count.rows[0].cnt), b.customer_comments||'', req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Tour not found' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── CHEMICAL APPLICATION LOG ──────────────────────────
app.get('/api/client/chemicals', authMiddleware, async function(req, res) {
  try {
    var result;
    var coScopeChem = companyScope(req);
    if (coScopeChem) {
      result = await getPool().query(
        'SELECT * FROM chemical_applications WHERE client_id=$1 AND company_id=$2 ORDER BY created_at DESC LIMIT 200',
        [req.user.id, coScopeChem]
      );
    } else if (req.user.user_type === 'sub_user') {
      var myName = req.user.full_name ? req.user.full_name + ' (' + req.user.username + ')' : req.user.username;
      result = await getPool().query(
        'SELECT * FROM chemical_applications WHERE client_id=$1 AND applied_by=$2 ORDER BY created_at DESC LIMIT 200',
        [req.user.id, myName]
      );
    } else {
      result = await getPool().query(
        'SELECT * FROM chemical_applications WHERE client_id=$1 ORDER BY created_at DESC LIMIT 200',
        [req.user.id]
      );
    }
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/client/chemicals', authMiddleware, async function(req, res) {
  var b = req.body;
  if (!b.product) return res.status(400).json({ error: 'Product name is required' });
  try {
    var result = await getPool().query(
      'INSERT INTO chemical_applications (client_id,tour_id,product,registration_no,batch_no,quantity,concentration,application_method,target_pest,treatment_area,ppe_used,weather,notes,applied_by,photo_url,company_id) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
      [req.user.id, b.tour_id||null, b.product, b.registration_no||'', b.batch_no||'',
       b.quantity||'', b.concentration||'', b.application_method||'', b.target_pest||'',
       b.treatment_area||'', b.ppe_used||'', b.weather||'', b.notes||'',
       b.applied_by || (req.user.full_name ? req.user.full_name + ' (' + req.user.username + ')' : req.user.username),
       b.photo_url || null, companyScope(req) || b.company_id || null]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── OWNER: FULL SYSTEM BACKUP (export all tables as JSON) ──
app.get('/api/owner/backup', ownerMiddleware, async function(req, res) {
  try {
    var p = getPool();
    if (!p) return res.status(500).json({ error: 'Database not configured' });

    var tables = [
      'clients', 'client_users', 'client_documents', 'devices',
      'inspections', 'corrective_actions', 'inspection_tours',
      'chemical_applications', 'payments', 'audit_log'
    ];

    var backup = {
      backup_version: '1.0',
      system: 'APQS IPM',
      generated_at: new Date().toISOString(),
      tables: {}
    };

    for (var i = 0; i < tables.length; i++) {
      var t = tables[i];
      try {
        var result = await p.query('SELECT * FROM ' + t);
        backup.tables[t] = result.rows;
      } catch (tableErr) {
        // Table may not exist on older DBs — skip gracefully
        backup.tables[t] = { error: 'Table not found or inaccessible: ' + tableErr.message };
      }
    }

    var filename = 'apqs-ipm-backup-' + new Date().toISOString().slice(0,10) + '.json';
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(JSON.stringify(backup, null, 2));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});



// ── PORTAL MIDDLEWARE (production company read-only users) ──
function portalMiddleware(req, res, next) {
  var auth = req.headers.authorization || '';
  var token = auth.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    var decoded = jwt.verify(token, process.env.JWT_SECRET || 'IPMControl2026Secret');
    if (decoded.user_type !== 'portal_user') return res.status(403).json({ error: 'Portal access only' });
    req.user = decoded;
    next();
  } catch(e) { return res.status(401).json({ error: 'Invalid token' }); }
}

// ── PORTAL ROUTES (read-only, scoped to production company) ──

// Portal: who am I?
app.get('/api/portal/me', portalMiddleware, async function(req, res) {
  try {
    var co = await getPool().query(
      'SELECT co.*, (SELECT COUNT(*) FROM devices d WHERE d.company_id=co.id) AS device_count FROM companies co WHERE co.id=$1',
      [req.user.company_id]
    );
    if (!co.rows.length) return res.status(404).json({ error: 'Company not found' });
    res.json(co.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Portal: dashboard stats
app.get('/api/portal/dashboard', portalMiddleware, async function(req, res) {
  try {
    var p = getPool();
    var cid = req.user.company_id;
    var insp = await p.query(
      'SELECT status, COUNT(*) AS cnt FROM inspections i ' +
      'JOIN devices d ON d.device_id=i.device_id AND d.client_id=i.client_id ' +
      'WHERE d.company_id=$1 AND i.created_at > NOW()-INTERVAL \'30 days\' GROUP BY status',
      [cid]
    );
    var cas = await p.query(
      'SELECT ca.status, ca.severity, COUNT(*) AS cnt FROM corrective_actions ca ' +
      'JOIN devices d ON d.device_id=ca.device_id AND d.client_id=ca.client_id ' +
      'WHERE d.company_id=$1 GROUP BY ca.status, ca.severity',
      [cid]
    );
    var devices = await p.query('SELECT COUNT(*) AS cnt FROM devices WHERE company_id=$1 AND active=TRUE', [cid]);
    var tours = await p.query(
      'SELECT COUNT(*) FILTER (WHERE status=\'completed\') AS completed, COUNT(*) FILTER (WHERE status=\'in_progress\') AS in_progress FROM inspection_tours WHERE company_id=$1',
      [cid]
    );
    var inspMap = { total:0, good:0, not_good:0, monitor:0 };
    insp.rows.forEach(function(r){ inspMap.total+=parseInt(r.cnt); if(r.status==='Good')inspMap.good+=parseInt(r.cnt); else if(r.status==='Not Good')inspMap.not_good+=parseInt(r.cnt); else inspMap.monitor+=parseInt(r.cnt); });
    var comp = inspMap.total ? Math.round(inspMap.good/inspMap.total*100) : null;
    res.json({ inspections: inspMap, compliance_rate: comp, cas: cas.rows, devices: parseInt(devices.rows[0].cnt), tours: tours.rows[0] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Portal: devices list
app.get('/api/portal/devices', portalMiddleware, async function(req, res) {
  try {
    var devs = await getPool().query(
      'SELECT d.*, (SELECT i.status FROM inspections i WHERE i.device_id=d.device_id AND i.client_id=d.client_id ORDER BY i.created_at DESC LIMIT 1) AS last_status, ' +
      '(SELECT COUNT(*) FROM corrective_actions ca WHERE ca.device_id=d.device_id AND ca.client_id=d.client_id AND ca.status=\'Open\') AS open_cas ' +
      'FROM devices d WHERE d.company_id=$1 AND d.active=TRUE ORDER BY d.device_id',
      [req.user.company_id]
    );
    res.json(devs.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Portal: inspections
app.get('/api/portal/inspections', portalMiddleware, async function(req, res) {
  try {
    var limit = Math.min(parseInt(req.query.limit)||200, 500);
    var result = await getPool().query(
      'SELECT i.* FROM inspections i ' +
      'JOIN devices d ON d.device_id=i.device_id AND d.client_id=i.client_id ' +
      'WHERE d.company_id=$1 ORDER BY i.created_at DESC LIMIT $2',
      [req.user.company_id, limit]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Portal: corrective actions
app.get('/api/portal/corrective-actions', portalMiddleware, async function(req, res) {
  try {
    var result = await getPool().query(
      'SELECT ca.* FROM corrective_actions ca ' +
      'JOIN devices d ON d.device_id=ca.device_id AND d.client_id=ca.client_id ' +
      'WHERE d.company_id=$1 ORDER BY ca.created_at DESC',
      [req.user.company_id]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Portal: tour reports
app.get('/api/portal/tours', portalMiddleware, async function(req, res) {
  try {
    var result = await getPool().query(
      'SELECT t.*, (SELECT COUNT(*) FROM inspections i WHERE i.tour_id=t.id) AS total_inspections FROM inspection_tours t WHERE t.company_id=$1 ORDER BY t.created_at DESC LIMIT 50',
      [req.user.company_id]
    );
    result.rows.forEach(function(r){ r.total_inspections=parseInt(r.total_inspections)||0; });
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Portal: single tour report with inspections
app.get('/api/portal/tours/:id', portalMiddleware, async function(req, res) {
  try {
    var p = getPool();
    var tour = await p.query('SELECT * FROM inspection_tours WHERE id=$1 AND company_id=$2', [req.params.id, req.user.company_id]);
    if (!tour.rows.length) return res.status(404).json({ error: 'Tour not found' });
    var insps = await p.query('SELECT * FROM inspections WHERE tour_id=$1 ORDER BY created_at', [req.params.id]);
    res.json({ tour: tour.rows[0], inspections: insps.rows });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PEST CONTROL ADMIN: Manage portal users for their companies ──
app.get('/api/client/companies/:id/portal-users', authMiddleware, mainAccountOnly, async function(req, res) {
  try {
    var tableCheck = await getPool().query("SELECT to_regclass('public.company_users') AS t");
    if (!tableCheck.rows[0].t) return res.json([]);
    var result = await getPool().query(
      'SELECT id, username, full_name, email, role, active, created_at FROM company_users WHERE company_id=$1 AND client_id=$2 ORDER BY created_at DESC',
      [req.params.id, req.user.id]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/client/companies/:id/portal-users', authMiddleware, mainAccountOnly, async function(req, res) {
  var b = req.body;
  if (!b.username || !b.password) return res.status(400).json({ error: 'Username and password are required' });
  var pwErr = checkPasswordStrength(b.password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    var tableCheck = await getPool().query("SELECT to_regclass('public.company_users') AS t");
    if (!tableCheck.rows[0].t) return res.status(503).json({ error: 'Portal feature not yet initialized — please wait a moment and retry' });
    var hash = await bcrypt.hash(b.password, 10);
    var result = await getPool().query(
      'INSERT INTO company_users (company_id, client_id, username, password_hash, full_name, email) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, username, full_name, email, role, active, created_at',
      [req.params.id, req.user.id, b.username, hash, b.full_name||'', b.email||'']
    );
    res.json(result.rows[0]);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/client/companies/:id/portal-users/:uid', authMiddleware, mainAccountOnly, async function(req, res) {
  try {
    await getPool().query('DELETE FROM company_users WHERE id=$1 AND company_id=$2 AND client_id=$3', [req.params.uid, req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENT: COMPANIES (customer sites) ────────────────
app.get('/api/client/companies', authMiddleware, async function(req, res) {
  if (companyScope(req)) return res.json([]); // production companies don't manage other companies
  try {
    var p = getPool();
    // If the companies table doesn't exist yet, return an empty list instead of erroring
    var tableCheck = await p.query("SELECT to_regclass('public.companies') AS t");
    if (!tableCheck.rows[0].t) return res.json([]);
    var result;
    if (req.user.user_type === 'sub_user') {
      result = await p.query(
        'SELECT DISTINCT c.* FROM companies c ' +
        'JOIN user_companies uc ON uc.company_id = c.id ' +
        'WHERE c.client_id=$1 AND uc.sub_user_id=$2 ORDER BY c.company_name',
        [req.user.id, req.user.sub_user_id]
      );
    } else {
      result = await p.query('SELECT * FROM companies WHERE client_id=$1 ORDER BY company_name', [req.user.id]);
    }
    // Attach device count + assigned user count to each company
    var companies = result.rows;
    for (var i = 0; i < companies.length; i++) {
      var devCount = await p.query('SELECT COUNT(*) AS cnt FROM devices WHERE company_id=$1', [companies[i].id]);
      var userCount = await p.query('SELECT COUNT(*) AS cnt FROM user_companies WHERE company_id=$1', [companies[i].id]);
      companies[i].device_count = parseInt(devCount.rows[0].cnt);
      companies[i].user_count = parseInt(userCount.rows[0].cnt);
    }
    res.json(companies);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/client/companies', authMiddleware, mainAccountOnly, async function(req, res) {
  var b = req.body;
  if (!b.company_name) return res.status(400).json({ error: 'Company name is required' });
  try {
    var result = await getPool().query(
      'INSERT INTO companies (client_id,company_name,address,contact_name,contact_phone,contact_email,industry,notes) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [req.user.id, b.company_name, b.address||'', b.contact_name||'', b.contact_phone||'',
       b.contact_email||'', b.industry||'', b.notes||'']
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.patch('/api/client/companies/:id', authMiddleware, mainAccountOnly, async function(req, res) {
  var b = req.body;
  try {
    var updates = [], vals = [], i = 1;
    ['company_name','address','contact_name','contact_phone','contact_email','industry','notes'].forEach(function(f) {
      if (b[f] !== undefined) { updates.push(f+'=$'+i++); vals.push(b[f]); }
    });
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    updates.push('updated_at=NOW()');
    vals.push(req.params.id); vals.push(req.user.id);
    var result = await getPool().query(
      'UPDATE companies SET ' + updates.join(',') + ' WHERE id=$'+i+' AND client_id=$'+(i+1)+' RETURNING *',
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Company not found' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/client/companies/:id', authMiddleware, mainAccountOnly, async function(req, res) {
  try {
    await getPool().query('DELETE FROM companies WHERE id=$1 AND client_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── PEST CONTROL: read-only report for one of their production companies ──
app.get('/api/client/companies/:id/report', authMiddleware, mainAccountOnly, async function(req, res) {
  try {
    var p = getPool();
    var cid = req.user.id;
    var companyId = req.params.id;
    // Verify this company belongs to the requesting pest control account
    var own = await p.query('SELECT id, company_name FROM companies WHERE id=$1 AND client_id=$2', [companyId, cid]);
    if (!own.rows.length) return res.status(404).json({ error: 'Company not found' });

    var insp = await p.query("SELECT status, COUNT(*) AS cnt FROM inspections WHERE client_id=$1 AND company_id=$2 AND created_at>NOW()-INTERVAL '30 days' GROUP BY status", [cid, companyId]);
    var cas  = await p.query('SELECT ca.status, ca.severity, COUNT(*) AS cnt FROM corrective_actions ca WHERE ca.client_id=$1 AND ca.company_id=$2 GROUP BY ca.status, ca.severity', [cid, companyId]);
    var dev  = await p.query('SELECT COUNT(*) AS cnt FROM devices WHERE client_id=$1 AND company_id=$2 AND active=TRUE', [cid, companyId]);
    var zones = await p.query("SELECT zone, COUNT(*) AS total, COUNT(*) FILTER(WHERE status='Good') AS good FROM inspections WHERE client_id=$1 AND company_id=$2 AND created_at>NOW()-INTERVAL '30 days' GROUP BY zone ORDER BY zone", [cid, companyId]);
    var recentInsp = await p.query('SELECT device_id, device_type, zone, status, deficiency_type, inspector, created_at FROM inspections WHERE client_id=$1 AND company_id=$2 ORDER BY created_at DESC LIMIT 50', [cid, companyId]);
    var openCas = await p.query('SELECT ca.device_id, ca.zone, ca.severity, ca.deficiency_type, ca.due_date, ca.status FROM corrective_actions ca WHERE ca.client_id=$1 AND ca.company_id=$2 ORDER BY ca.created_at DESC LIMIT 100', [cid, companyId]);

    var tot=0,good=0,ng=0,mon=0;
    insp.rows.forEach(function(r){ var n=parseInt(r.cnt); tot+=n; if(r.status==='Good')good+=n; else if(r.status==='Not Good')ng+=n; else mon+=n; });

    res.json({
      company: own.rows[0],
      inspections: { total:tot, good:good, not_good:ng, monitor:mon },
      compliance_rate: tot ? Math.round(good/tot*100) : null,
      cas: cas.rows,
      devices: parseInt(dev.rows[0].cnt),
      zones: zones.rows.map(function(z){ return { zone:z.zone, total:parseInt(z.total), good:parseInt(z.good) }; }),
      recent_inspections: recentInsp.rows,
      open_cas: openCas.rows.filter(function(x){ return x.status==='Open'; })
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENT: COMPANY <-> USER ASSIGNMENTS ──────────────
app.get('/api/client/companies/:id/users', authMiddleware, mainAccountOnly, async function(req, res) {
  try {
    var result = await getPool().query(
      'SELECT cu.id, cu.username, cu.full_name, cu.role, ' +
      '(uc.id IS NOT NULL) AS assigned ' +
      'FROM client_users cu ' +
      'LEFT JOIN user_companies uc ON uc.sub_user_id = cu.id AND uc.company_id = $1 ' +
      'WHERE cu.client_id=$2 AND cu.active=TRUE ORDER BY cu.full_name',
      [req.params.id, req.user.id]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/client/companies/:id/users', authMiddleware, mainAccountOnly, async function(req, res) {
  var subUserId = req.body.sub_user_id;
  if (!subUserId) return res.status(400).json({ error: 'sub_user_id is required' });
  try {
    // Verify the user belongs to this client
    var check = await getPool().query('SELECT id FROM client_users WHERE id=$1 AND client_id=$2', [subUserId, req.user.id]);
    if (!check.rows.length) return res.status(404).json({ error: 'User not found' });
    await getPool().query(
      'INSERT INTO user_companies (sub_user_id, company_id) VALUES ($1,$2) ON CONFLICT (sub_user_id, company_id) DO NOTHING',
      [subUserId, req.params.id]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/client/companies/:id/users/:userId', authMiddleware, mainAccountOnly, async function(req, res) {
  try {
    await getPool().query(
      'DELETE FROM user_companies WHERE company_id=$1 AND sub_user_id=$2',
      [req.params.id, req.params.userId]
    );
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENT: DEVICES - SINGLE ADD ─────────────────────
app.post('/api/client/devices', authMiddleware, mainAccountOnly, async function(req, res) {
  var b = req.body;
  if (!b.device_id || !b.device_type) return res.status(400).json({ error: 'device_id and device_type required' });
  try {
    var p = getPool();
    var singleCompanyId = b.company_id || companyScope(req) || null;
    // Check for existing device within the same company
    var dupCheck;
    if (singleCompanyId) {
      dupCheck = await p.query('SELECT id FROM devices WHERE client_id=$1 AND device_id=$2 AND company_id=$3 LIMIT 1', [req.user.id, b.device_id, singleCompanyId]);
    } else {
      dupCheck = await p.query('SELECT id FROM devices WHERE client_id=$1 AND device_id=$2 AND company_id IS NULL LIMIT 1', [req.user.id, b.device_id]);
    }
    if (dupCheck.rows.length) return res.json({ skipped: true, device_id: b.device_id, reason: 'already exists in this company' });
    var result;
    try {
      result = await p.query(
        'INSERT INTO devices (client_id,device_id,device_type,zone,location,company_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
        [req.user.id, b.device_id, b.device_type, b.zone||'', b.location||b.zone||'', singleCompanyId]
      );
    } catch(colErrS) {
      result = await p.query(
        'INSERT INTO devices (client_id,device_id,device_type,zone,location) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [req.user.id, b.device_id, b.device_type, b.zone||'', b.location||b.zone||'']
      );
    }
    res.json(result.rows[0] || { skipped: true, device_id: b.device_id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENT: DEVICES - BULK ADD ────────────────────────
// POST /api/client/devices/bulk
// Body: { devices: [ { device_id, device_type, location, zone }, ... ] }
// Returns: { added: N, skipped: N, errors: N, results: [...] }
app.post('/api/client/devices/bulk', authMiddleware, mainAccountOnly, async function(req, res) {
  var items = req.body.devices;
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'devices array is required and must not be empty' });
  }
  if (items.length > 500) {
    return res.status(400).json({ error: 'Maximum 500 devices per batch' });
  }

  var p = getPool();
  if (!p) return res.status(500).json({ error: 'Database not configured' });

  // Company accounts can only create devices for their own facility
  var coBulk = companyScope(req);
  if (coBulk) {
    items.forEach(function(it) { it.company_id = coBulk; });
  }
  // Validate each item before inserting
  for (var i = 0; i < items.length; i++) {
    if (!items[i].device_id || !items[i].device_type) {
      return res.status(400).json({
        error: 'Each device must have device_id and device_type',
        bad_index: i,
        bad_item: items[i]
      });
    }
    if (!items[i].company_id) {
      // company_id is required once Companies feature is set up; warn but don't block
      console.warn('Device submitted without company_id:', items[i].device_id);
    }
  }

  var added = 0;
  var skipped = 0;
  var errors = 0;
  var results = [];

  // Use a transaction for atomicity
  var client = await p.connect();
  try {
    await client.query('BEGIN');

    for (var j = 0; j < items.length; j++) {
      var d = items[j];
      try {
        var r;
        var devCompanyId = d.company_id || companyScope(req) || null;
        // Check for an existing device with the same ID *within the same company*
        var existsCheck;
        if (devCompanyId) {
          existsCheck = await client.query(
            'SELECT id FROM devices WHERE client_id=$1 AND device_id=$2 AND company_id=$3 LIMIT 1',
            [req.user.id, d.device_id, devCompanyId]
          );
        } else {
          existsCheck = await client.query(
            'SELECT id FROM devices WHERE client_id=$1 AND device_id=$2 AND company_id IS NULL LIMIT 1',
            [req.user.id, d.device_id]
          );
        }
        if (existsCheck.rows.length > 0) {
          skipped++;
          results.push({ device_id: d.device_id, status: 'skipped', reason: 'already exists in this company' });
          continue;
        }
        // Insert — device is unique within its company
        try {
          r = await client.query(
            'INSERT INTO devices (client_id, device_id, device_type, zone, location, company_id) ' +
            'VALUES ($1, $2, $3, $4, $5, $6) RETURNING device_id',
            [req.user.id, d.device_id, d.device_type, d.zone||d.location||'', d.location||d.zone||'', devCompanyId]
          );
        } catch(colErr2) {
          // Fallback if company_id column doesn't exist yet
          r = await client.query(
            'INSERT INTO devices (client_id, device_id, device_type, zone, location) ' +
            'VALUES ($1, $2, $3, $4, $5) RETURNING device_id',
            [req.user.id, d.device_id, d.device_type, d.zone||d.location||'', d.location||d.zone||'']
          );
        }
        if (r.rows.length > 0) {
          added++;
          results.push({ device_id: d.device_id, status: 'added' });
        } else {
          skipped++;
          results.push({ device_id: d.device_id, status: 'skipped', reason: 'already exists' });
        }
      } catch(itemErr) {
        errors++;
        results.push({ device_id: d.device_id, status: 'error', reason: itemErr.message });
      }
    }

    await client.query('COMMIT');
    res.json({
      success: true,
      total:   items.length,
      added:   added,
      skipped: skipped,
      errors:  errors,
      results: results
    });
  } catch(txErr) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'Transaction failed: ' + txErr.message });
  } finally {
    client.release();
  }
});

// ── CLIENT: INSPECTIONS GET ───────────────────────────
app.get('/api/client/inspections', authMiddleware, async function(req, res) {
  var limit = parseInt(req.query.limit) || 200;
  try {
    var p = getPool(); if(!p) return res.status(500).json({error:"Database not configured. Add DATABASE_URL to Railway Variables"});
    var result;
    var coScope = companyScope(req);
    if (coScope) {
      // Production company account: only their own facility's inspections
      result = await p.query(
        'SELECT * FROM inspections WHERE client_id=$1 AND company_id=$2 ORDER BY created_at DESC LIMIT $3',
        [req.user.id, coScope, limit]
      );
    } else if (req.user.user_type === 'sub_user') {
      // Technicians only see their own submissions
      result = await p.query(
        'SELECT * FROM inspections WHERE client_id=$1 AND sub_user_id=$2 ORDER BY created_at DESC LIMIT $3',
        [req.user.id, req.user.sub_user_id, limit]
      );
    } else {
      result = await p.query(
        'SELECT * FROM inspections WHERE client_id=$1 ORDER BY created_at DESC LIMIT $2',
        [req.user.id, limit]
      );
    }
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENT: INSPECTIONS POST ──────────────────────────
app.post('/api/client/inspections', authMiddleware, async function(req, res) {
  var b = req.body;
  if (!b.device_id || !b.status) return res.status(400).json({ error: 'device_id and status required' });
  try {
    var p = getPool(); if(!p) return res.status(500).json({error:"Database not configured. Add DATABASE_URL to Railway Variables"});
    // Offline dedupe: skip if this offline_key already synced
    if (b.offline_key) {
      var dup = await p.query('SELECT id FROM inspections WHERE client_id=$1 AND offline_key=$2', [req.user.id, b.offline_key]);
      if (dup.rows.length) return res.json(Object.assign({duplicate:true}, dup.rows[0]));
    }
    // Determine which company this inspection belongs to
    var inspCompanyId = companyScope(req);
    if (!inspCompanyId) {
      try {
        var devLookup = await p.query('SELECT company_id FROM devices WHERE device_id=$1 AND client_id=$2 LIMIT 1', [b.device_id, req.user.id]);
        if (devLookup.rows.length) inspCompanyId = devLookup.rows[0].company_id;
      } catch(e) { inspCompanyId = null; }
    }
    var result = await p.query(
      'INSERT INTO inspections (client_id,device_id,device_type,zone,status,deficiency_type,notes,photo_url,gps_lat,gps_lng,inspector,tour_id,findings,offline_key,sub_user_id,company_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *',
      [req.user.id, b.device_id, b.device_type||'', b.zone||'', b.status,
       b.deficiency_type||null, b.notes||null, b.photo_url||null,
       b.gps_lat||null, b.gps_lng||null, b.inspector||'', b.tour_id||null,
       b.findings ? JSON.stringify(b.findings) : null, b.offline_key||null,
       req.user.user_type === 'sub_user' ? req.user.sub_user_id : null,
       inspCompanyId || null]
    );
    var insp = result.rows[0];
    var ca = null;
    if (b.status === 'Not Good' && b.deficiency_type) {
      var rule = DEFICIENCY_RULES[b.deficiency_type] || DEFAULT_RULE;
      var due  = new Date(Date.now() + rule.h * 3600000);
      var caResult;
      try {
        caResult = await getPool().query(
          'INSERT INTO corrective_actions (client_id,inspection_id,device_id,zone,severity,deficiency_type,department,due_date,company_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [req.user.id, insp.id, b.device_id, b.zone||'', rule.sev, b.deficiency_type, rule.dept, due, inspCompanyId || null]
        );
      } catch(caColErr) {
        // Fallback if company_id column doesn't exist yet
        caResult = await getPool().query(
          'INSERT INTO corrective_actions (client_id,inspection_id,device_id,zone,severity,deficiency_type,department,due_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
          [req.user.id, insp.id, b.device_id, b.zone||'', rule.sev, b.deficiency_type, rule.dept, due]
        );
      }
      ca = caResult.rows[0];
    }
    res.json({ inspection: insp, corrective_action: ca });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENT: CORRECTIVE ACTIONS GET ───────────────────
app.get('/api/client/corrective-actions', authMiddleware, async function(req, res) {
  try {
    var p = getPool(); if(!p) return res.status(500).json({error:"Database not configured. Add DATABASE_URL to Railway Variables"});
    var result;
    var coScopeCA = companyScope(req);
    if (coScopeCA) {
      // Production company account: only their own facility's corrective actions.
      // Match strictly by the CA's own company_id, or (for legacy CAs with no company_id)
      // by a device that belongs to this company AND shares the same tour/inspection lineage.
      result = await p.query(
        'SELECT ca.* FROM corrective_actions ca ' +
        'WHERE ca.client_id=$1 AND ca.company_id=$2 ORDER BY ca.created_at DESC',
        [req.user.id, coScopeCA]
      );
    } else if (req.user.user_type === 'sub_user') {
      // Technicians only see CAs generated from their own inspections
      result = await p.query(
        'SELECT ca.* FROM corrective_actions ca ' +
        'JOIN inspections i ON i.id = ca.inspection_id ' +
        'WHERE ca.client_id=$1 AND i.sub_user_id=$2 ORDER BY ca.created_at DESC',
        [req.user.id, req.user.sub_user_id]
      );
    } else {
      result = await p.query(
        'SELECT * FROM corrective_actions WHERE client_id=$1 ORDER BY created_at DESC',
        [req.user.id]
      );
    }
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENT: CORRECTIVE ACTIONS PATCH ─────────────────
app.patch('/api/client/corrective-actions/:id', authMiddleware, async function(req, res) {
  var status = req.body.status;
  var notes  = req.body.resolution_notes || '';
  var closed = status === 'Closed' ? new Date().toISOString() : null;
  try {
    var p = getPool(); if(!p) return res.status(500).json({error:"Database not configured. Add DATABASE_URL to Railway Variables"});
    var result = await p.query(
      'UPDATE corrective_actions SET status=$1,resolution_notes=$2,closed_at=$3 WHERE id=$4 AND client_id=$5 RETURNING *',
      [status, notes, closed, req.params.id, req.user.id]
    );
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENT: DASHBOARD ─────────────────────────────────
app.get('/api/client/dashboard', authMiddleware, async function(req, res) {
  var cid = req.user.id;
  var coDash = companyScope(req);
  try {
    if (coDash) {
      // Production company account: scope everything to their facility
      var p2 = getPool();
      var dInsp = await p2.query("SELECT status, COUNT(*) AS cnt FROM inspections WHERE client_id=$1 AND company_id=$2 AND created_at>NOW()-INTERVAL '30 days' GROUP BY status", [cid, coDash]);
      var dCas  = await p2.query('SELECT ca.status, ca.severity, COUNT(*) AS cnt FROM corrective_actions ca WHERE ca.client_id=$1 AND ca.company_id=$2 GROUP BY ca.status, ca.severity', [cid, coDash]);
      var dDev  = await p2.query('SELECT COUNT(*) AS cnt FROM devices WHERE client_id=$1 AND company_id=$2 AND active=TRUE', [cid, coDash]);
      var dZone = await p2.query("SELECT zone, COUNT(*) AS total, COUNT(*) FILTER(WHERE status='Good') AS good FROM inspections WHERE client_id=$1 AND company_id=$2 AND created_at>NOW()-INTERVAL '30 days' GROUP BY zone ORDER BY zone", [cid, coDash]);
      var dTot=0,dGood=0,dNg=0,dMon=0;
      dInsp.rows.forEach(function(r){ var n=parseInt(r.cnt); dTot+=n; if(r.status==='Good')dGood+=n; else if(r.status==='Not Good')dNg+=n; else dMon+=n; });
      return res.json({
        inspections: { total:dTot, good:dGood, not_good:dNg, monitor:dMon },
        compliance_rate: dTot ? Math.round(dGood/dTot*100) : null,
        cas: dCas.rows,
        devices: parseInt(dDev.rows[0].cnt),
        zones: dZone.rows.map(function(z){ return { zone:z.zone, total:parseInt(z.total), good:parseInt(z.good) }; })
      });
    }
    var insps   = await getPool().query('SELECT status, COUNT(*) AS cnt FROM inspections WHERE client_id=$1 AND created_at>NOW()-INTERVAL \'30 days\' GROUP BY status', [cid]);
    var cas     = await getPool().query('SELECT status, severity, COUNT(*) AS cnt FROM corrective_actions WHERE client_id=$1 GROUP BY status,severity', [cid]);
    var devices = await getPool().query('SELECT COUNT(*) AS cnt FROM devices WHERE client_id=$1 AND active=TRUE', [cid]);
    var zones   = await getPool().query('SELECT zone, COUNT(*) AS total, COUNT(*) FILTER(WHERE status=\'Good\') AS good FROM inspections WHERE client_id=$1 AND created_at>NOW()-INTERVAL \'30 days\' GROUP BY zone', [cid]);
    var im = {};
    insps.rows.forEach(function(r) { im[r.status] = parseInt(r.cnt); });
    var total = Object.values(im).reduce(function(a,b){ return a+b; }, 0);
    var good  = im['Good'] || 0;
    res.json({
      inspections:     { total: total, good: good, not_good: im['Not Good']||0, monitor: im['Monitor']||0 },
      compliance_rate: total ? Math.round(good/total*100) : null,
      cas:             cas.rows,
      devices:         parseInt(devices.rows[0].cnt),
      zones:           zones.rows
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENT: ME ────────────────────────────────────────
app.get('/api/client/me', authMiddleware, async function(req, res) {
  try {
    var p = getPool(); if(!p) return res.status(500).json({error:"Database not configured. Add DATABASE_URL to Railway Variables"});
    var result = await p.query('SELECT * FROM clients WHERE id=$1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    var safe = Object.assign({}, result.rows[0]);
    delete safe.password_hash;
    var days = Math.ceil((new Date(safe.current_period_end) - new Date()) / 86400000);
    res.json(Object.assign(safe, { days_left: days, expired: days <= 0 }));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENT: CHANGE PASSWORD ───────────────────────────
app.post('/api/client/change-password', authMiddleware, async function(req, res) {
  var oldPass = req.body.old_password || '';
  var newPass = req.body.new_password || '';
  var pwErrCp = checkPasswordStrength(newPass);
  if (pwErrCp) return res.status(400).json({ error: pwErrCp });
  try {
    // Technicians change their own password in client_users
    if (req.user.user_type === 'sub_user') {
      var su = await getPool().query('SELECT * FROM client_users WHERE id=$1', [req.user.sub_user_id]);
      if (!su.rows.length) return res.status(404).json({ error: 'User not found' });
      var okSu = await bcrypt.compare(oldPass, su.rows[0].password_hash);
      if (!okSu) return res.status(401).json({ error: 'Current password is incorrect' });
      var newHashSu = await bcrypt.hash(newPass, 10);
      await getPool().query('UPDATE client_users SET password_hash=$1 WHERE id=$2', [newHashSu, req.user.sub_user_id]);
      return res.json({ ok: true });
    }
    var result = await getPool().query('SELECT * FROM clients WHERE id=$1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    var valid = await bcrypt.compare(oldPass, result.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
    var hash = await bcrypt.hash(newPass, 10);
    await getPool().query('UPDATE clients SET password_hash=$1, updated_at=NOW() WHERE id=$2', [hash, req.user.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CLIENT: USERS ─────────────────────────────────────
app.get('/api/client/users', authMiddleware, async function(req, res) {
  try {
    var result = await getPool().query(
      'SELECT * FROM client_users WHERE client_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/client/users', authMiddleware, mainAccountOnly, pestControlOnly, async function(req, res) {
  var b = req.body;
  if (!b.username || !b.password)
    return res.status(400).json({ error: 'Username and password required' });
  var pwErr = checkPasswordStrength(b.password);
  if (pwErr) return res.status(400).json({ error: pwErr });
  try {
    var p0 = getPool();
    var clientRow = await p0.query('SELECT plan, max_users FROM clients WHERE id=$1', [req.user.id]);
    var plan = clientRow.rows.length ? clientRow.rows[0].plan : 'trial';
    var maxUsers = clientRow.rows.length && clientRow.rows[0].max_users ? parseInt(clientRow.rows[0].max_users) : 3;
    if (plan === 'trial') maxUsers = Math.min(maxUsers, 3);
    var countRow = await p0.query('SELECT COUNT(*) AS cnt FROM client_users WHERE client_id=$1 AND active=TRUE', [req.user.id]);
    if (parseInt(countRow.rows[0].cnt) >= maxUsers) {
      return res.status(403).json({ error: 'User limit reached (' + maxUsers + ' users max' + (plan==='trial' ? ' on free trial' : '') + '). Contact us to upgrade.' });
    }
    var hash = await bcrypt.hash(b.password, 10);
    var result = await getPool().query(
      'INSERT INTO client_users (client_id,username,password_hash,full_name,role,department) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, b.username, hash, b.full_name||'', b.role||'inspector', b.department||'']
    );
    var safe = Object.assign({}, result.rows[0]);
    delete safe.password_hash;
    res.json(safe);
  } catch(e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Username already exists' });
    res.status(500).json({ error: e.message });
  }
});

app.patch('/api/client/users/:id', authMiddleware, mainAccountOnly, pestControlOnly, async function(req, res) {
  var b = req.body;
  if (b.new_password) {
    var pwE = checkPasswordStrength(b.new_password);
    if (pwE) return res.status(400).json({ error: pwE });
  }
  try {
    if (b.password) {
      var hash = await bcrypt.hash(b.password, 10);
      await getPool().query(
        'UPDATE client_users SET password_hash=$1 WHERE id=$2 AND client_id=$3',
        [hash, req.params.id, req.user.id]
      );
    }
    var result = await getPool().query(
      'UPDATE client_users SET full_name=COALESCE($1,full_name), role=COALESCE($2,role), department=COALESCE($3,department) WHERE id=$4 AND client_id=$5 RETURNING *',
      [b.full_name, b.role, b.department, req.params.id, req.user.id]
    );
    var safe = Object.assign({}, result.rows[0]);
    delete safe.password_hash;
    res.json(safe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/client/users/:id', authMiddleware, mainAccountOnly, pestControlOnly, async function(req, res) {
  try {
    await getPool().query('DELETE FROM client_users WHERE id=$1 AND client_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── OWNER: UPDATE CLIENT ──────────────────────────────
app.patch('/api/owner/clients/:id', ownerMiddleware, async function(req, res) {
  var b = req.body;
  try {
    var updates = [];
    var vals = [];
    var i = 1;
    if (b.company_name) { updates.push('company_name=$'+i++); vals.push(b.company_name); }
    if (b.email)        { updates.push('email=$'+i++);        vals.push(b.email); }
    if (b.phone)        { updates.push('phone=$'+i++);        vals.push(b.phone); }
    if (b.plan)         { updates.push('plan=$'+i++);         vals.push(b.plan); }
    if (b.new_password) {
      var hash = await bcrypt.hash(b.new_password, 10);
      updates.push('password_hash=$'+i++); vals.push(hash);
    }
    if (b.new_username) { updates.push('username=$'+i++); vals.push(b.new_username); }
    if (b.notes !== undefined) { updates.push('notes=$'+i++); vals.push(b.notes); }
    if (parseInt(b.max_users) > 0) { updates.push('max_users=$'+i++); vals.push(parseInt(b.max_users)); }
    if (b.country)      { updates.push('country=$'+i++);      vals.push(b.country); }
    if (b.logo_url !== undefined) { updates.push('logo_url=$'+i++); vals.push(b.logo_url); }
    updates.push('updated_at=NOW()');
    vals.push(req.params.id);
    var result = await getPool().query(
      'UPDATE clients SET '+updates.join(',')+' WHERE id=$'+i+' RETURNING *',
      vals
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    var safe = Object.assign({}, result.rows[0]);
    delete safe.password_hash;
    res.json(safe);
  } catch(e) { res.status(500).json({ error: e.message }); }
});


// ── OWNER: CLIENT CONTRACTS ────────────────────────────
// List contracts for a client
app.get('/api/owner/clients/:id/contracts', ownerMiddleware, async function(req, res) {
  try {
    var result = await getPool().query(
      'SELECT id,client_id,title,file_type,file_name,contract_start,contract_end,status,notes,uploaded_by,created_at ' +
      'FROM client_contracts WHERE client_id=$1 ORDER BY created_at DESC',
      [req.params.id]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get single contract (includes file_data for viewing/downloading)
app.get('/api/owner/contracts/:id', ownerMiddleware, async function(req, res) {
  try {
    var result = await getPool().query('SELECT * FROM client_contracts WHERE id=$1', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Contract not found' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Upload a new contract for a client
app.post('/api/owner/clients/:id/contracts', ownerMiddleware, async function(req, res) {
  var b = req.body;
  if (!b.title || !b.file_data) return res.status(400).json({ error: 'Title and file are required' });
  try {
    var result = await getPool().query(
      'INSERT INTO client_contracts (client_id,title,file_data,file_type,file_name,contract_start,contract_end,status,notes,uploaded_by) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,client_id,title,file_type,file_name,contract_start,contract_end,status,notes,uploaded_by,created_at',
      [req.params.id, b.title, b.file_data, b.file_type||'application/pdf', b.file_name||'',
       b.contract_start||null, b.contract_end||null, b.status||'active', b.notes||'', b.uploaded_by||'Owner']
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Delete a contract
app.delete('/api/owner/contracts/:id', ownerMiddleware, async function(req, res) {
  try {
    await getPool().query('DELETE FROM client_contracts WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── OWNER: STATS WITH CLIENT DETAIL ───────────────────
app.get('/api/owner/stats', ownerMiddleware, async function(req, res) {
  try {
    var c  = await getPool().query("SELECT COUNT(*) AS total, COUNT(*) FILTER(WHERE status='active') AS active, COUNT(*) FILTER(WHERE current_period_end < NOW()) AS expired FROM clients");
    var cd = await getPool().query('SELECT id,company_name,current_period_end FROM clients ORDER BY current_period_end ASC');
    var r  = await getPool().query("SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM payments WHERE status='paid'");
    var ins = await getPool().query("SELECT COUNT(*) AS total FROM inspections WHERE created_at > NOW()-INTERVAL '30 days'");
    var a  = await getPool().query("SELECT COUNT(*) AS open FROM corrective_actions WHERE status='Open'");
    res.json({
      clients: c.rows[0],
      clients_detail: cd.rows,
      revenue: r.rows[0],
      inspections: ins.rows[0],
      cas: a.rows[0]
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// ── CLIENT: DOCUMENTS (MSDS + Layout) ────────────
app.get('/api/client/documents', authMiddleware, async function(req, res) {
  try {
    var p = getPool();
    var result = await p.query(
      'SELECT * FROM client_documents WHERE client_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
    res.json(result.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/client/documents', authMiddleware, mainAccountOnly, async function(req, res) {
  var b = req.body;
  if (!b.name || !b.doc_type || !b.file_data)
    return res.status(400).json({ error: 'name, doc_type, and file_data required' });
  if (!['msds','layout','other'].includes(b.doc_type))
    return res.status(400).json({ error: 'doc_type must be msds, layout, or other' });
  try {
    var p = getPool();
    var result = await p.query(
      'INSERT INTO client_documents (client_id, name, doc_type, file_data, file_type, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,name,doc_type,file_type,uploaded_by,created_at',
      [req.user.id, b.name, b.doc_type, b.file_data, b.file_type||'application/pdf', b.uploaded_by||req.user.username]
    );
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/client/documents/:id', authMiddleware, async function(req, res) {
  try {
    var p = getPool();
    var result = await p.query(
      'SELECT * FROM client_documents WHERE id=$1 AND client_id=$2',
      [req.params.id, req.user.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/client/documents/:id', authMiddleware, mainAccountOnly, async function(req, res) {
  try {
    var p = getPool();
    await p.query('DELETE FROM client_documents WHERE id=$1 AND client_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── START ─────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', function() {
  console.log('');
  console.log('IPM Control API started on port ' + PORT);
  console.log('OWNER_EMAIL:    ' + (process.env.OWNER_EMAIL    ? process.env.OWNER_EMAIL    : 'NOT SET - login will fail'));
  console.log('OWNER_PASSWORD: ' + (process.env.OWNER_PASSWORD ? '*** set ***'               : 'NOT SET - login will fail'));
  console.log('JWT_SECRET:     ' + (process.env.JWT_SECRET     ? '*** set ***'               : 'using default'));
  console.log('DATABASE_URL:        ' + (process.env.DATABASE_URL        ? 'SET' : 'not set'));
  console.log('DATABASE_PUBLIC_URL: ' + (process.env.DATABASE_PUBLIC_URL ? 'SET' : 'not set'));
  console.log('ACTIVE DB:           ' + (process.env.DATABASE_URL||process.env.DATABASE_PUBLIC_URL ? 'CONNECTED' : 'NONE - DB WILL FAIL'));
  console.log('');
});
