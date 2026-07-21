require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

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
var pool;
try {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  console.log('Database pool created');
} catch(e) {
  console.error('Database pool error:', e.message);
}

// ── CONSTANTS ─────────────────────────────────────────
var PLANS = {
  trial:        { days: 7,   price: 0,   max_users: 5,   max_devices: 30  },
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
  var db    = process.env.DATABASE_URL || 'NOT_SET';
  res.json({
    OWNER_EMAIL:          email,
    OWNER_EMAIL_LENGTH:   email.length,
    OWNER_PASSWORD:       pass === 'NOT_SET' ? 'NOT_SET' : '*'.repeat(pass.length),
    OWNER_PASSWORD_LENGTH: pass.length,
    JWT_SECRET:           jwts === 'NOT_SET' ? 'NOT_SET' : 'SET_(' + jwts.length + '_chars)',
    DATABASE_URL:         db === 'NOT_SET' ? 'NOT_SET' : 'SET',
    NODE_ENV:             process.env.NODE_ENV || 'NOT_SET',
    PORT:                 process.env.PORT || 'NOT_SET'
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
  if (email !== envEmail) {
    return res.status(401).json({ error: 'Wrong email. Expected: ' + envEmail });
  }
  if (password !== envPass) {
    return res.status(401).json({ error: 'Wrong password' });
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
    var result = await pool.query(
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

  try {
    var hash    = await bcrypt.hash(b.password, 10);
    var lic     = genLicense(b.company_name);
    var expires = new Date(Date.now() + planCfg.days * 86400000);

    var result = await pool.query(
      'INSERT INTO clients (company_name,contact_name,email,phone,industry,username,password_hash,plan,payment_method,license_key,max_users,max_devices,current_period_end,notes) ' +
      'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *',
      [b.company_name, b.contact_name||'', b.email, b.phone||'', b.industry||'',
       b.username, hash, b.plan, b.payment_method||'manual',
       lic, planCfg.max_users, planCfg.max_devices, expires, b.notes||'']
    );
    var client = result.rows[0];

    for (var i = 0; i < DEVICE_SEED.length; i++) {
      var d = DEVICE_SEED[i];
      await pool.query(
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
    var result = await pool.query(sql, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── OWNER: DELETE CLIENT ──────────────────────────────
app.delete('/api/owner/clients/:id', ownerMiddleware, async function(req, res) {
  try {
    await pool.query('DELETE FROM clients WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── OWNER: STATS ──────────────────────────────────────
app.get('/api/owner/stats', ownerMiddleware, async function(req, res) {
  try {
    var c = await pool.query('SELECT COUNT(*) AS total, COUNT(*) FILTER(WHERE status=\'active\') AS active, COUNT(*) FILTER(WHERE current_period_end < NOW()) AS expired FROM clients');
    var r = await pool.query('SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM payments WHERE status=\'paid\'');
    var i = await pool.query('SELECT COUNT(*) AS total FROM inspections WHERE created_at > NOW()-INTERVAL \'30 days\'');
    var a = await pool.query('SELECT COUNT(*) AS open FROM corrective_actions WHERE status=\'Open\'');
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
    var result = await pool.query(
      'INSERT INTO payments (client_id,amount,currency,plan,period_months,method,status,invoice_number,notes,paid_at) VALUES ($1,$2,\'SAR\',$3,$4,\'manual\',\'paid\',$5,$6,NOW()) RETURNING *',
      [b.client_id, b.amount, b.plan, b.period_months||1, inv, b.notes||'']
    );
    var months = b.period_months || 1;
    await pool.query(
      'UPDATE clients SET current_period_end=GREATEST(current_period_end,NOW())+INTERVAL \'' + (months*30) + ' days\', plan=$1, updated_at=NOW() WHERE id=$2',
      [b.plan, b.client_id]
    );
    res.json(result.rows[0]);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── OWNER: GET PAYMENTS ───────────────────────────────
app.get('/api/owner/payments', ownerMiddleware, async function(req, res) {
  try {
    var result = await pool.query(
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
  try {
    var result = await pool.query('SELECT * FROM clients WHERE username=$1', [username]);
    if (!result.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    var client = result.rows[0];
    var valid = await bcrypt.compare(password, client.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
    if (client.status !== 'active') return res.status(403).json({ error: 'Account suspended' });
    var days = Math.ceil((new Date(client.current_period_end) - new Date()) / 86400000);
    var secret = process.env.JWT_SECRET || 'IPMControl2026DefaultSecret';
    var token = jwt.sign(
      { id: client.id, username: client.username, role: 'client', plan: client.plan, expired: days <= 0 },
      secret, { expiresIn: '24h' }
    );
    var safe = Object.assign({}, client);
    delete safe.password_hash;
    res.json({ token: token, client: safe, expired: days <= 0 });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENT: ME ────────────────────────────────────────
app.get('/api/client/me', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query('SELECT * FROM clients WHERE id=$1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    var safe = Object.assign({}, result.rows[0]);
    delete safe.password_hash;
    var days = Math.ceil((new Date(safe.current_period_end) - new Date()) / 86400000);
    res.json(Object.assign(safe, { days_left: days, expired: days <= 0 }));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENT: DEVICES ───────────────────────────────────
app.get('/api/client/devices', authMiddleware, async function(req, res) {
  try {
    var result = await pool.query(
      'SELECT * FROM devices WHERE client_id=$1 AND active=TRUE ORDER BY device_id',
      [req.user.id]
    );
    res.json(result.rows);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── CLIENT: INSPECTIONS GET ───────────────────────────
app.get('/api/client/inspections', authMiddleware, async function(req, res) {
  var limit = parseInt(req.query.limit) || 200;
  try {
    var result = await pool.query(
      'SELECT * FROM inspections WHERE client_id=$1 ORDER BY created_at DESC LIMIT $2',
      [req.user.id, limit]
    );
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
    var result = await pool.query(
      'INSERT INTO inspections (client_id,device_id,device_type,zone,status,deficiency_type,notes,photo_url,gps_lat,gps_lng,inspector) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [req.user.id, b.device_id, b.device_type||'', b.zone||'', b.status,
       b.deficiency_type||null, b.notes||null, b.photo_url||null,
       b.gps_lat||null, b.gps_lng||null, b.inspector||'']
    );
    var insp = result.rows[0];
    var ca = null;
    if (b.status === 'Not Good' && b.deficiency_type) {
      var rule = DEFICIENCY_RULES[b.deficiency_type] || DEFAULT_RULE;
      var due  = new Date(Date.now() + rule.h * 3600000);
      var caResult = await pool.query(
        'INSERT INTO corrective_actions (client_id,inspection_id,device_id,zone,severity,deficiency_type,department,due_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [req.user.id, insp.id, b.device_id, b.zone||'', rule.sev, b.deficiency_type, rule.dept, due]
      );
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
    var result = await pool.query(
      'SELECT * FROM corrective_actions WHERE client_id=$1 ORDER BY created_at DESC',
      [req.user.id]
    );
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
    var result = await pool.query(
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
  try {
    var insps   = await pool.query('SELECT status, COUNT(*) AS cnt FROM inspections WHERE client_id=$1 AND created_at>NOW()-INTERVAL \'30 days\' GROUP BY status', [cid]);
    var cas     = await pool.query('SELECT status, severity, COUNT(*) AS cnt FROM corrective_actions WHERE client_id=$1 GROUP BY status,severity', [cid]);
    var devices = await pool.query('SELECT COUNT(*) AS cnt FROM devices WHERE client_id=$1 AND active=TRUE', [cid]);
    var zones   = await pool.query('SELECT zone, COUNT(*) AS total, COUNT(*) FILTER(WHERE status=\'Good\') AS good FROM inspections WHERE client_id=$1 AND created_at>NOW()-INTERVAL \'30 days\' GROUP BY zone', [cid]);
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
    var result = await pool.query('SELECT * FROM clients WHERE id=$1', [req.user.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    var safe = Object.assign({}, result.rows[0]);
    delete safe.password_hash;
    var days = Math.ceil((new Date(safe.current_period_end) - new Date()) / 86400000);
    res.json(Object.assign(safe, { days_left: days, expired: days <= 0 }));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── START ─────────────────────────────────────────────
app.listen(PORT, function() {
  console.log('');
  console.log('IPM Control API started on port ' + PORT);
  console.log('OWNER_EMAIL:    ' + (process.env.OWNER_EMAIL    ? process.env.OWNER_EMAIL    : 'NOT SET - login will fail'));
  console.log('OWNER_PASSWORD: ' + (process.env.OWNER_PASSWORD ? '*** set ***'               : 'NOT SET - login will fail'));
  console.log('JWT_SECRET:     ' + (process.env.JWT_SECRET     ? '*** set ***'               : 'using default'));
  console.log('DATABASE_URL:   ' + (process.env.DATABASE_URL   ? 'set'                       : 'NOT SET - DB will fail'));
  console.log('');
});
