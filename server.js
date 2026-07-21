
Claude finished the response
1784595021495_image.png
still not working

The connection is working now ✅ — I can see it's reaching Railway (https://ipm-control-backend-production.up.railway.app/api).

The problem is simple: the email or password doesn't match what's in Railway Variables.

I can see you're using alaminhma@gmail.com — let's verify it matches exactly.

Fix in 2 Minutes
Step 1 — Check Railway Variables
Go to railway.app → your project → backend service
Click "Variables" tab
Find these two variables and check them exactly:
OWNER_EMAIL     = ???
OWNER_PASSWORD  = ???
Tell me what values you set — or change them right now to something simple:
OWNER_EMAIL    = alaminhma@gmail.com
OWNER_PASSWORD = Admin1234!
Click Save → wait 1 minute for Railway to redeploy.

Step 2 — Try Login Again
Use exactly what you put in Railway Variables:

Email: alaminhma@gmail.com
Password: whatever you set as OWNER_PASSWORD
Step 3 — If Still Failing, Reset the Variables
In Railway Variables, delete both and re-add them fresh:

Variable	Set to
OWNER_EMAIL	alaminhma@gmail.com
OWNER_PASSWORD	Admin1234!
JWT_SECRET	IPMSecret2026XYZ
Save → wait 60 seconds → try login again.

The connection is working perfectly — this is only a credentials mismatch. Tell me what your OWNER_PASSWORD is set to in Railway and I'll confirm if it matches.

the emIL nd the password are matched but still not working

The credentials match but login fails — this means the backend is rejecting them. Let me check the exact comparison logic in server.js:


Ran a command, viewed a file
Ran a command, viewed a file
The logic is correct. The problem is one of these common Railway issues — environment variables not loaded, extra spaces, or Railway didn't redeploy after saving. Let me add a debug endpoint so we can see exactly what Railway has:


Ran 2 commands, read a file
Ran 2 commands, read a file
Do These 3 Things Right Now
1 — Update server.js on GitHub
Go to your GitHub repo ipm-control-backend
Click server.js → click the pencil icon ✏️
Select all → delete → paste the new server.js
Click "Commit changes"
Wait 2 minutes for Railway to redeploy
2 — Open the Debug URL
After Railway redeploys, open this in your browser:

https://ipm-control-backend-production.up.railway.app/api/debug/env
You will see something like:

json
{
  "OWNER_EMAIL": "alaminhma@gmail.com",
  "OWNER_EMAIL_LEN": 19,
  "OWNER_PASSWORD": "**********",
  "OWNER_PASSWORD_LEN": 10,
  "JWT_SECRET": "SET (20 chars)",
  "DATABASE_URL": "SET"
}
Tell me what you see — especially:

Is OWNER_EMAIL showing your correct email?
Is OWNER_PASSWORD_LEN showing the right number of characters?
Is JWT_SECRET showing SET or NOT SET?
Is DATABASE_URL showing SET or NOT SET?
3 — Most Likely Fix Right Now
While waiting for the debug — go to Railway Variables and check these common mistakes:

Common Mistake	Example
Extra space in email	alaminhma@gmail.com  ← space at end
Extra space in password	 Admin1234! ← space at start
JWT_SECRET is empty	Must have a value — any text works
DATABASE_URL missing	Must be set for server to start
If JWT_SECRET is NOT SET — the server crashes silently on every login attempt even if email/password are correct. This is the most common cause.


Server
JS 





Claude is AI and can make mistakes. Please double-check responses.
Server · JS
// ═══════════════════════════════════════════════════════
//  IPM Control System — Backend API Server
//  © 2026 Hamid Malik Elamin — All Rights Reserved
// ═══════════════════════════════════════════════════════
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const { Pool }   = require('pg');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const rateLimit  = require('express-rate-limit');
const nodemailer = require('nodemailer');
 
const app  = express();
const PORT = process.env.PORT || 5000;
 
// ── DB ────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV==='production'?{rejectUnauthorized:false}:false });
 
// ── MIDDLEWARE ────────────────────────────────────────
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:5500',
           process.env.FRONTEND_URL || '*',
           /\.netlify\.app$/, /\.railway\.app$/],
  credentials: true
}));
// Allow all origins in development
app.use((req,res,next)=>{
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Methods','GET,POST,PATCH,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers','Content-Type,Authorization');
  if(req.method==='OPTIONS')return res.sendStatus(200);
  next();
});
app.use(express.json({ limit:'10mb' }));
 
const limiter = rateLimit({ windowMs:15*60*1000, max:200 });
app.use(limiter);
 
// ── CONSTANTS ─────────────────────────────────────────
const PLANS = {
  trial:        { days:7,   price:0,   max_users:5,   max_devices:30  },
  basic:        { days:30,  price:299,  max_users:10,  max_devices:50  },
  professional: { days:30,  price:599,  max_users:25,  max_devices:100 },
  enterprise:   { days:30,  price:999,  max_users:999, max_devices:999 },
};
 
const DEVICE_SEED = [
  {id:'D-0001',type:'Rodent Bait Station',      zone:'Zone A - Cold Storage',  location:'Near entrance door'},
  {id:'D-0002',type:'Rodent Glue Board',         zone:'Zone B - Packaging',     location:'Under conveyor line 1'},
  {id:'D-0003',type:'Rodent Snap Trap',          zone:'Zone C - Processing',    location:'Wall mount south'},
  {id:'D-0004',type:'Rodent Bait Station',       zone:'Zone D - Warehouse',     location:'Corner NW'},
  {id:'D-0005',type:'Rodent Bait Station',       zone:'Perimeter NE',           location:'External north wall'},
  {id:'D-0006',type:'Cockroach Glue Trap',       zone:'Zone A - Cold Storage',  location:'Behind refrigeration units'},
  {id:'D-0007',type:'Cockroach Bait Station',    zone:'Zone B - Packaging',     location:'Under equipment cabinets'},
  {id:'D-0008',type:'Cockroach Glue Trap',       zone:'Zone C - Processing',    location:'Floor drain area'},
  {id:'D-0009',type:'Cockroach Bait Station',    zone:'Zone D - Warehouse',     location:'Pallet storage corners'},
  {id:'D-0010',type:'Fly Trap - UV Light',       zone:'Zone A - Cold Storage',  location:'Ceiling mount NE corner'},
  {id:'D-0011',type:'Fly Kit',                   zone:'Zone C - Processing',    location:'Above prep area'},
  {id:'D-0012',type:'Fly Kit',                   zone:'Zone D - Warehouse',     location:'Loading dock'},
  {id:'D-0013',type:'Air Curtain',               zone:'Zone B - Packaging',     location:'Main door'},
  {id:'D-0014',type:'Fly Glue Board',            zone:'Main Entrance',          location:'Reception area'},
  {id:'D-0015',type:'Ant Bait Station',          zone:'Zone A - Cold Storage',  location:'Wall perimeter east'},
  {id:'D-0016',type:'Ant Bait Station',          zone:'Zone B - Packaging',     location:'Near water lines'},
  {id:'D-0017',type:'Ant Glue Trap',             zone:'Zone C - Processing',    location:'Equipment base areas'},
  {id:'D-0018',type:'Mosquito Trap - CO2',       zone:'Perimeter NE',           location:'External east wall'},
  {id:'D-0019',type:'Mosquito UV Trap',          zone:'Main Entrance',          location:'Above entrance canopy'},
  {id:'D-0020',type:'Mosquito Larvicide Station',zone:'Perimeter NE',           location:'Drainage area north'},
  {id:'D-0021',type:'Pheromone Trap - SPI',      zone:'Zone D - Warehouse',     location:'Grain storage area NW'},
  {id:'D-0022',type:'Pheromone Trap - SPI',      zone:'Zone D - Warehouse',     location:'Grain storage area SE'},
  {id:'D-0023',type:'Stored Product Insect Trap',zone:'Zone C - Processing',    location:'Raw material intake'},
  {id:'D-0024',type:'SPI Monitoring Trap',       zone:'Zone A - Cold Storage',  location:'Dry goods storage'},
  {id:'D-0025',type:'Bird Net - Exclusion',      zone:'Zone D - Warehouse',     location:'Loading dock roof'},
  {id:'D-0026',type:'Bird Spike Strip',          zone:'Perimeter NE',           location:'Roof ledge north'},
  {id:'D-0027',type:'Bird Deterrent - Sonic',    zone:'Main Entrance',          location:'External canopy'},
  {id:'D-0028',type:'Bird Wire System',          zone:'Zone B - Packaging',     location:'Roof beam structure'},
];
 
// ── HELPERS ───────────────────────────────────────────
const genLicenseKey = (name) => {
  const safe = name.replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0,4).padEnd(4,'X');
  return `IPM-${safe}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;
};
 
const auth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};
 
const ownerAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'owner') return res.status(403).json({ error: 'Owner only' });
    req.user = decoded;
    next();
  } catch { res.status(401).json({ error: 'Invalid token' }); }
};
 
const sendEmail = async (to, subject, html) => {
  if (!process.env.SMTP_USER) return;
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST, port: process.env.SMTP_PORT,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  await transporter.sendMail({ from: `"IPM Control" <${process.env.SMTP_USER}>`, to, subject, html });
};
 
// ══════════════════════════════════════════════════════
//  OWNER ROUTES
// ══════════════════════════════════════════════════════
 
// Owner Login
app.post('/api/owner/login', async (req, res) => {
  const { email, password } = req.body;
  if (email !== process.env.OWNER_EMAIL || password !== process.env.OWNER_PASSWORD)
    return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ role:'owner', email }, process.env.JWT_SECRET, { expiresIn:'12h' });
  res.json({ token, role:'owner' });
});
 
// Get all clients
app.get('/api/owner/clients', ownerAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT c.*,
      (SELECT COUNT(*) FROM inspections i WHERE i.client_id=c.id) AS total_inspections,
      (SELECT COUNT(*) FROM corrective_actions ca WHERE ca.client_id=c.id AND ca.status='Open') AS open_cas,
      (SELECT SUM(p.amount) FROM payments p WHERE p.client_id=c.id AND p.status='paid') AS total_paid
    FROM clients c ORDER BY c.created_at DESC
  `);
  res.json(rows);
});
 
// Create client (owner)
app.post('/api/owner/clients', ownerAuth, async (req, res) => {
  const { company_name, contact_name, email, phone, industry, username, password, plan, payment_method, notes } = req.body;
  if (!company_name || !email || !username || !password || !plan)
    return res.status(400).json({ error: 'Missing required fields' });
 
  const planCfg = PLANS[plan];
  if (!planCfg) return res.status(400).json({ error: 'Invalid plan' });
 
  const password_hash = await bcrypt.hash(password, 10);
  const license_key   = genLicenseKey(company_name);
  const trial_ends_at = new Date(Date.now() + planCfg.days * 86400000);
 
  try {
    const { rows } = await pool.query(`
      INSERT INTO clients (company_name,contact_name,email,phone,industry,username,password_hash,plan,payment_method,license_key,max_users,max_devices,current_period_end,notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [company_name, contact_name, email, phone, industry, username, password_hash, plan, payment_method||'manual', license_key, planCfg.max_users, planCfg.max_devices, trial_ends_at, notes]
    );
    const client = rows[0];
 
    // Seed devices
    for (const d of DEVICE_SEED) {
      await pool.query(
        `INSERT INTO devices (client_id,device_id,device_type,zone,location) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [client.id, d.id, d.type, d.zone, d.location]
      );
    }
 
    // Send welcome email
    await sendEmail(email, 'Welcome to IPM Control', `
      <h2>Welcome, ${company_name}!</h2>
      <p>Your IPM Control account is ready.</p>
      <p><strong>Login URL:</strong> ${process.env.FRONTEND_URL}</p>
      <p><strong>Username:</strong> ${username}</p>
      <p><strong>Password:</strong> ${password}</p>
      <p><strong>Plan:</strong> ${plan} | Expires: ${trial_ends_at.toLocaleDateString()}</p>
      <p><strong>License Key:</strong> ${license_key}</p>
      <p>© 2026 Hamid Malik Elamin — IPM Control</p>
    `);
 
    res.json({ client, license_key });
  } catch (e) {
    if (e.code==='23505') return res.status(400).json({ error: 'Username or email already exists' });
    throw e;
  }
});
 
// Renew / extend client
app.patch('/api/owner/clients/:id/renew', ownerAuth, async (req, res) => {
  const { days, plan } = req.body;
  const { id } = req.params;
  const addDays = parseInt(days) || 30;
  const planCfg = plan ? PLANS[plan] : null;
 
  const updates = [`current_period_end = GREATEST(current_period_end, NOW()) + INTERVAL '${addDays} days'`, `updated_at=NOW()`];
  if (planCfg) {
    updates.push(`plan='${plan}'`, `max_users=${planCfg.max_users}`, `max_devices=${planCfg.max_devices}`);
  }
 
  const { rows } = await pool.query(`UPDATE clients SET ${updates.join(',')} WHERE id=$1 RETURNING *`, [id]);
  if (!rows.length) return res.status(404).json({ error: 'Client not found' });
  res.json(rows[0]);
});
 
// Delete client
app.delete('/api/owner/clients/:id', ownerAuth, async (req, res) => {
  await pool.query('DELETE FROM clients WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});
 
// Owner stats dashboard
app.get('/api/owner/stats', ownerAuth, async (req, res) => {
  const [clients, revenue, inspections, cas] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER(WHERE status='active') AS active,
      COUNT(*) FILTER(WHERE current_period_end < NOW()) AS expired FROM clients`),
    pool.query(`SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM payments WHERE status='paid'`),
    pool.query(`SELECT COUNT(*) AS total FROM inspections WHERE created_at > NOW()-INTERVAL '30 days'`),
    pool.query(`SELECT COUNT(*) AS open FROM corrective_actions WHERE status='Open'`),
  ]);
  res.json({
    clients: clients.rows[0],
    revenue: revenue.rows[0],
    inspections: inspections.rows[0],
    cas: cas.rows[0],
  });
});
 
// Record manual payment
app.post('/api/owner/payments', ownerAuth, async (req, res) => {
  const { client_id, amount, plan, period_months, notes } = req.body;
  const invoice_number = `INV-${Date.now().toString(36).toUpperCase()}`;
  const { rows } = await pool.query(`
    INSERT INTO payments (client_id,amount,currency,plan,period_months,method,status,invoice_number,notes,paid_at)
    VALUES ($1,$2,'SAR',$3,$4,'manual','paid',$5,$6,NOW()) RETURNING *`,
    [client_id, amount, plan, period_months||1, invoice_number, notes]
  );
  // Extend subscription
  await pool.query(
    `UPDATE clients SET current_period_end = GREATEST(current_period_end,NOW()) + INTERVAL '${(period_months||1)*30} days', plan=$1, updated_at=NOW() WHERE id=$2`,
    [plan, client_id]
  );
  res.json(rows[0]);
});
 
// Get payment history
app.get('/api/owner/payments', ownerAuth, async (req, res) => {
  const { rows } = await pool.query(`
    SELECT p.*, c.company_name FROM payments p
    JOIN clients c ON c.id=p.client_id ORDER BY p.created_at DESC LIMIT 100`);
  res.json(rows);
});
 
// ══════════════════════════════════════════════════════
//  CLIENT AUTH
// ══════════════════════════════════════════════════════
 
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  const { rows } = await pool.query('SELECT * FROM clients WHERE username=$1', [username]);
  if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
  const client = rows[0];
  const valid = await bcrypt.compare(password, client.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid credentials' });
  if (client.status !== 'active') return res.status(403).json({ error: 'Account suspended' });
  const expired = new Date(client.current_period_end) < new Date();
  const token = jwt.sign(
    { id:client.id, username:client.username, role:'client', plan:client.plan, expired },
    process.env.JWT_SECRET, { expiresIn:'24h' }
  );
  const { password_hash, ...safeClient } = client;
  res.json({ token, client: safeClient, expired });
});
 
// ══════════════════════════════════════════════════════
//  CLIENT API ROUTES
// ══════════════════════════════════════════════════════
 
// Get client profile + subscription status
app.get('/api/client/me', auth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const { password_hash, ...safe } = rows[0];
  const daysLeft = Math.ceil((new Date(safe.current_period_end) - new Date()) / 86400000);
  res.json({ ...safe, days_left: daysLeft, expired: daysLeft <= 0 });
});
 
// ── DEVICES ──────────────────────────────────────────
app.get('/api/client/devices', auth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM devices WHERE client_id=$1 AND active=TRUE ORDER BY device_id',
    [req.user.id]
  );
  res.json(rows);
});
 
app.post('/api/client/devices', auth, async (req, res) => {
  const { device_id, device_type, zone, location } = req.body;
  const { rows } = await pool.query(
    'INSERT INTO devices (client_id,device_id,device_type,zone,location) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING *',
    [req.user.id, device_id, device_type, zone, location]
  );
  res.json(rows[0]);
});
 
// ── INSPECTIONS ──────────────────────────────────────
app.get('/api/client/inspections', auth, async (req, res) => {
  const limit = parseInt(req.query.limit) || 200;
  const { rows } = await pool.query(
    'SELECT * FROM inspections WHERE client_id=$1 ORDER BY created_at DESC LIMIT $2',
    [req.user.id, limit]
  );
  res.json(rows);
});
 
app.post('/api/client/inspections', auth, async (req, res) => {
  const { device_id, device_type, zone, status, deficiency_type, notes, photo_url, gps_lat, gps_lng, inspector } = req.body;
  if (!device_id || !status) return res.status(400).json({ error: 'device_id and status required' });
 
  const { rows } = await pool.query(`
    INSERT INTO inspections (client_id,device_id,device_type,zone,status,deficiency_type,notes,photo_url,gps_lat,gps_lng,inspector)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [req.user.id, device_id, device_type, zone, status, deficiency_type, notes, photo_url, gps_lat||null, gps_lng||null, inspector]
  );
  const insp = rows[0];
 
  // Auto-create CA for Not Good
  let ca = null;
  if (status === 'Not Good' && deficiency_type) {
    const RULES = {
      'Rodent Activity - Live Sighting':   {sev:'Critical', dept:'Pest Tech',   h:24},
      'Rodent Activity - Droppings':       {sev:'Critical', dept:'Pest Tech',   h:24},
      'Rodent Activity - Gnaw Marks':      {sev:'Critical', dept:'Pest Tech',   h:24},
      'Rodent Trap Triggered':             {sev:'Critical', dept:'Pest Tech',   h:24},
      'Bait Consumed - Rodent':            {sev:'Critical', dept:'Maintenance', h:24},
      'Bait Consumed':                     {sev:'Critical', dept:'Maintenance', h:24},
      'Cockroach Activity - Live Sighting':{sev:'Critical', dept:'Pest Tech',   h:24},
      'Cockroach Activity - Egg Cases':    {sev:'Critical', dept:'Pest Tech',   h:24},
      'Bait Consumed - Cockroach':         {sev:'Critical', dept:'Pest Tech',   h:24},
      'SPI Infestation in Product':        {sev:'Critical', dept:'Pest Tech',   h:24},
      'Door Gap':                          {sev:'Critical', dept:'Maintenance', h:24},
      'Wall Crack':                        {sev:'Critical', dept:'Maintenance', h:24},
      'Bird Entry Point Found':            {sev:'Critical', dept:'Maintenance', h:24},
    };
    const rule = RULES[deficiency_type] || {sev:'Medium', dept:'Pest Tech', h:72};
    const due  = new Date(Date.now() + rule.h * 3600000);
    const { rows: caRows } = await pool.query(`
      INSERT INTO corrective_actions (client_id,inspection_id,device_id,zone,severity,deficiency_type,department,due_date)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.user.id, insp.id, device_id, zone, rule.sev, deficiency_type, rule.dept, due]
    );
    ca = caRows[0];
  }
 
  res.json({ inspection: insp, corrective_action: ca });
});
 
// ── CORRECTIVE ACTIONS ───────────────────────────────
app.get('/api/client/corrective-actions', auth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM corrective_actions WHERE client_id=$1 ORDER BY created_at DESC',
    [req.user.id]
  );
  res.json(rows);
});
 
app.patch('/api/client/corrective-actions/:id', auth, async (req, res) => {
  const { status, resolution_notes } = req.body;
  const closed_at = status === 'Closed' ? new Date().toISOString() : null;
  const { rows } = await pool.query(`
    UPDATE corrective_actions SET status=$1, resolution_notes=$2, closed_at=$3
    WHERE id=$4 AND client_id=$5 RETURNING *`,
    [status, resolution_notes, closed_at, req.params.id, req.user.id]
  );
  res.json(rows[0]);
});
 
// ── DASHBOARD STATS ───────────────────────────────────
app.get('/api/client/dashboard', auth, async (req, res) => {
  const cid = req.user.id;
  const [insps, cas, devices, zones] = await Promise.all([
    pool.query(`SELECT status, COUNT(*) AS cnt FROM inspections WHERE client_id=$1 AND created_at>NOW()-INTERVAL '30 days' GROUP BY status`, [cid]),
    pool.query(`SELECT status, severity, COUNT(*) AS cnt FROM corrective_actions WHERE client_id=$1 GROUP BY status,severity`, [cid]),
    pool.query(`SELECT COUNT(*) AS cnt FROM devices WHERE client_id=$1 AND active=TRUE`, [cid]),
    pool.query(`SELECT zone, COUNT(*) AS total, COUNT(*) FILTER(WHERE status='Good') AS good FROM inspections WHERE client_id=$1 AND created_at>NOW()-INTERVAL '30 days' GROUP BY zone`, [cid]),
  ]);
  const inspMap = {};
  insps.rows.forEach(r => inspMap[r.status] = parseInt(r.cnt));
  const total = Object.values(inspMap).reduce((a,b)=>a+b,0);
  const good  = inspMap['Good'] || 0;
  res.json({
    inspections: { total, good, not_good: inspMap['Not Good']||0, monitor: inspMap['Monitor']||0 },
    compliance_rate: total ? Math.round(good/total*100) : null,
    cas: cas.rows,
    devices: parseInt(devices.rows[0].cnt),
    zones: zones.rows,
  });
});
 
// Audit log
app.get('/api/client/audit', auth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT * FROM audit_log WHERE client_id=$1 ORDER BY created_at DESC LIMIT 200',
    [req.user.id]
  );
  res.json(rows);
});
 
// ── STRIPE PAYMENT ────────────────────────────────────
if (process.env.STRIPE_SECRET_KEY) {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
 
  app.post('/api/payment/create-checkout', auth, async (req, res) => {
    const { plan } = req.body;
    const planCfg = PLANS[plan];
    if (!planCfg || plan === 'trial') return res.status(400).json({ error: 'Invalid plan' });
 
    const { rows } = await pool.query('SELECT * FROM clients WHERE id=$1', [req.user.id]);
    const client = rows[0];
 
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      customer_email: client.email,
      line_items: [{
        price_data: {
          currency: 'sar',
          product_data: {
            name: `IPM Control — ${plan.charAt(0).toUpperCase()+plan.slice(1)} Plan`,
            description: `${planCfg.max_users} users · ${planCfg.max_devices} devices · 30 days`,
          },
          unit_amount: planCfg.price * 100,
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${process.env.FRONTEND_URL}?payment=success&plan=${plan}`,
      cancel_url:  `${process.env.FRONTEND_URL}?payment=cancelled`,
      metadata: { client_id: client.id, plan },
    });
    res.json({ url: session.url });
  });
 
  app.post('/api/payment/webhook', express.raw({type:'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;
    try { event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET); }
    catch { return res.status(400).send('Webhook error'); }
 
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const { client_id, plan } = s.metadata;
      const planCfg = PLANS[plan];
      await pool.query(
        `UPDATE clients SET plan=$1,max_users=$2,max_devices=$3,
          current_period_end=GREATEST(current_period_end,NOW())+INTERVAL '30 days',
          payment_method='stripe',stripe_customer_id=$4,updated_at=NOW() WHERE id=$5`,
        [plan, planCfg.max_users, planCfg.max_devices, s.customer, client_id]
      );
      await pool.query(
        `INSERT INTO payments (client_id,amount,currency,plan,period_months,method,stripe_payment_id,status,paid_at)
         VALUES ($1,$2,'SAR',$3,1,'stripe',$4,'paid',NOW())`,
        [client_id, s.amount_total/100, plan, s.payment_intent]
      );
    }
    res.json({ received: true });
  });
}
 
// ── HEALTH CHECK ─────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status:'ok', time:new Date(), system:'IPM Control © 2026 Hamid Malik Elamin' });
});
 
// ── DEBUG ENDPOINT (remove after fixing login) ────────
app.get('/api/debug/env', (req, res) => {
  const email = process.env.OWNER_EMAIL || 'NOT SET';
  const pass  = process.env.OWNER_PASSWORD || 'NOT SET';
  const jwt   = process.env.JWT_SECRET ? 'SET ('+process.env.JWT_SECRET.length+' chars)' : 'NOT SET';
  const db    = process.env.DATABASE_URL ? 'SET' : 'NOT SET';
  res.json({
    OWNER_EMAIL:    email,
    OWNER_EMAIL_LEN: email.length,
    OWNER_PASSWORD: pass.replace(/./g,'*'),
    OWNER_PASSWORD_LEN: pass.length,
    JWT_SECRET: jwt,
    DATABASE_URL: db,
    NODE_ENV: process.env.NODE_ENV || 'NOT SET',
  });
});
 
// ── START ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🛡️  IPM Control API running on port ${PORT}`);
  console.log(`   © 2026 Hamid Malik Elamin\n`);
});
 
module.exports = app;
 




