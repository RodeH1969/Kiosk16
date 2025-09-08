// server.js — Kiosk poster + tracking + PDF + hard-force ad pack + scan cooldown

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { Pool } = require('pg');

const app = express();

/* ------------ CONFIG ------------ */
const PORT = process.env.PORT || 3030;
const ADMIN_KEY = process.env.ADMIN_KEY || null;
const DATABASE_URL = process.env.DATABASE_URL || null;
const GAME_URL = process.env.GAME_URL || 'https://flashka.onrender.com';

// HARD FORCE: set 1..7 via env; if unset/invalid, default to 3 (MAFS)
const FORCE_AD = (process.env.FORCE_AD || '3').trim();
const FORCED = /^[1-7]$/.test(FORCE_AD) ? FORCE_AD : '3';

/* ------------ STATIC ------------ */
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.use(express.json());

// Trust proxy for IP detection
app.set('trust proxy', true);

/* --------- HELPERS / TZ --------- */
const BRIS_TZ = 'Australia/Brisbane';
function dayKeyBrisbane(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BRIS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
function buildBaseUrl(req) { return `${req.protocol}://${req.get('host')}`; }
async function makeQrPngBuffer(text, opts = {}) {
  return QRCode.toBuffer(text, { errorCorrectionLevel: 'M', margin: 1, scale: 10, ...opts });
}
function requireAdmin(req, res) {
  if (!ADMIN_KEY) return null;
  if ((req.query.key || '') === ADMIN_KEY) return null;
  res.status(401).send('Unauthorized. Append ?key=YOUR_ADMIN_KEY to the URL.');
  return 'blocked';
}

/* -------- STORAGE (PG/JSON) ----- */
const DATA_DIR = path.join(__dirname, 'data');
const METRICS_FILE = path.join(DATA_DIR, 'metrics.json');

function ensureDataDir() { if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true }); }
function loadJson(file, fallback) { try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')) : fallback; } catch { return fallback; } }
function saveJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

function fileStore() {
  ensureDataDir();
  let metrics = loadJson(METRICS_FILE, { tz: BRIS_TZ, days: {} });
  const saveMetrics = () => saveJson(METRICS_FILE, metrics);
  return {
    async init() {},
    async bumpScan() {
      const day = dayKeyBrisbane();
      if (!metrics.days[day]) metrics.days[day] = { qr_scans: 0, redirects: 0 };
      metrics.days[day].qr_scans++; saveMetrics();
    },
    async bumpRedirect() {
      const day = dayKeyBrisbane();
      if (!metrics.days[day]) metrics.days[day] = { qr_scans: 0, redirects: 0 };
      metrics.days[day].redirects++; saveMetrics();
    },
    async getMetrics() { return metrics; },
    async getMetricsRows() {
      const days = Object.keys(metrics.days).sort();
      return days.map((d) => ({ day: d, ...metrics.days[d] }));
    },
  };
}

function pgStore() {
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false }, max: 5 });
  return {
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS metrics_days (
          day DATE PRIMARY KEY,
          qr_scans INTEGER NOT NULL DEFAULT 0,
          redirects INTEGER NOT NULL DEFAULT 0
        );`);
    },
    async bumpScan() {
      const day = dayKeyBrisbane();
      await pool.query(
        `INSERT INTO metrics_days(day, qr_scans, redirects)
         VALUES ($1::date, 1, 0)
         ON CONFLICT (day) DO UPDATE SET qr_scans = metrics_days.qr_scans + 1`, [day]);
    },
    async bumpRedirect() {
      const day = dayKeyBrisbane();
      await pool.query(
        `INSERT INTO metrics_days(day, qr_scans, redirects)
         VALUES ($1::date, 0, 1)
         ON CONFLICT (day) DO UPDATE SET redirects = metrics_days.redirects + 1`, [day]);
    },
    async getMetrics() {
      const r = await pool.query(`SELECT day, qr_scans, redirects FROM metrics_days ORDER BY day`);
      const out = { tz: BRIS_TZ, days: {} };
      for (const row of r.rows) {
        const d = (row.day instanceof Date ? row.day : new Date(row.day)).toISOString().slice(0, 10);
        out.days[d] = { qr_scans: Number(row.qr_scans) || 0, redirects: Number(row.redirects) || 0 };
      }
      return out;
    },
    async getMetricsRows() {
      const r = await pool.query(`SELECT day, qr_scans, redirects FROM metrics_days ORDER BY day`);
      return r.rows.map((row) => {
        const d = (row.day instanceof Date ? row.day : new Date(row.day)).toISOString().slice(0, 10);
        return { day: d, qr_scans: Number(row.qr_scans) || 0, redirects: Number(row.redirects) || 0 };
      });
    },
  };
}

/* >>> SINGLE store declaration <<< */
const store = DATABASE_URL ? pgStore() : fileStore();

/* ----------- SCAN COOLDOWN ----------- */
const SCAN_COOLDOWN_MINUTES = 60; // 1 hour between scans per IP
const recentScans = new Map(); // IP -> timestamp

function isRecentScan(ip) {
  const now = Date.now();
  const lastScan = recentScans.get(ip);
  
  if (!lastScan) return false;
  
  const cooldownMs = SCAN_COOLDOWN_MINUTES * 60 * 1000;
  return (now - lastScan) < cooldownMs;
}

function recordScan(ip) {
  recentScans.set(ip, Date.now());
  
  // Clean old entries (older than 2x cooldown)
  const cutoff = Date.now() - (SCAN_COOLDOWN_MINUTES * 2 * 60 * 1000);
  for (const [scanIp, timestamp] of recentScans.entries()) {
    if (timestamp < cutoff) {
      recentScans.delete(scanIp);
    }
  }
}

function getRemainingCooldown(ip) {
  const lastScan = recentScans.get(ip);
  if (!lastScan) return 0;
  
  const now = Date.now();
  const cooldownMs = SCAN_COOLDOWN_MINUTES * 60 * 1000;
  const remaining = cooldownMs - (now - lastScan);
  
  return Math.max(0, Math.ceil(remaining / (60 * 1000))); // minutes
}

/* ------------- ROUTES ------------- */
// Poster page (NO scan URL line shown)
app.get('/kiosk', async (req, res) => {
  const scanUrl = `${buildBaseUrl(req)}/kiosk/scan`;
  const dataUrl = await QRCode.toDataURL(scanUrl, { errorCorrectionLevel: 'M', margin: 1, scale: 10 });

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Flashka — Scan to Play</title>
<link href="https://fonts.googleapis.com/css2?family=Bangers&display=swap" rel="stylesheet">
<style>
  :root{--card-w:min(560px,94vw)}
  *{box-sizing:border-box}
  body{margin:0;background:#f6f6f6;color:#111;font-family:Arial,Helvetica,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .wrap{width:var(--card-w);background:#fff;border:1px solid #eee;border-radius:20px;box-shadow:0 10px 36px rgba(0,0,0,.08);padding:18px 18px 22px;text-align:center}
  .logo{max-width:460px;width:100%;height:auto;object-fit:contain;display:block;margin:6px auto 8px}
  .qrBox{display:inline-block;border:1px solid #e7e7e7;border-radius:14px;padding:14px;background:#fff;margin:2px auto 8px}
  .qrBox img{width:min(320px,72vw);height:auto;display:block}
  .lines{margin-top:6px;line-height:1.35}
  .lines .big{font-size:32px;margin:6px 0 2px}
  .lines .big.with-choccy{display:inline-flex;align-items:center;gap:12px;justify-content:center;flex-wrap:wrap}
  .lines .big.with-choccy .title{font-family:'Bangers',system-ui,Arial,Helvetica,sans-serif;color:#d32f2f;font-weight:700;letter-spacing:.5px;text-transform:uppercase;line-height:1;}
  .lines .big.with-choccy img.choccy{max-height:260px;height:auto;width:auto}
  .lines .mid{font-size:18px;margin:6px 0 2px}
  .lines .small{font-size:14px;color:#444;margin:2px 0}
  .lines .small.emph{font-weight:700;letter-spacing:.5px}
  @media print { body{background:#fff} .wrap{box-shadow:none;border:none} }
</style>
</head><body>
  <div class="wrap">
    <img class="logo" src="/flashka_logo.png" alt="Flashka"/>
    <div class="qrBox"><img src="${dataUrl}" alt="Scan to play"/></div>
    <div class="lines">
      <div class="big with-choccy">
        <span class="title">Win a CHOCCY!</span>
        <img src="/choccy.png" alt="" class="choccy"/>
      </div>
      <div class="mid">1 Scan per visit</div>
      <div class="small emph">FREE TO PLAY</div>
    </div>
  </div>
</body></html>`;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// PDF export
app.get('/kiosk.pdf', async (req, res) => {
  let puppeteer;
  try { puppeteer = require('puppeteer'); }
  catch { res.status(500).send('Puppeteer not installed. Run: npm install puppeteer'); return; }

  const targetUrl = `${buildBaseUrl(req)}/kiosk`;
  const size = String(req.query.size || 'A4').toUpperCase();
  const margin = String(req.query.margin || '10mm');

  let browser;
  try {
    browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox','--disable-setuid-sandbox'] });
    const page = await browser.newPage();
    await page.goto(targetUrl, { waitUntil: 'networkidle0', timeout: 60000 });
    const pdf = await page.pdf({ format: size, printBackground: true, margin: { top: margin, right: margin, bottom: margin, left: margin } });
    await browser.close();
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="kiosk-${size.toLowerCase()}.pdf"`);
    res.send(pdf);
  } catch (err) {
    if (browser) { try { await browser.close(); } catch {} }
    console.error('PDF error:', err);
    res.status(500).send('Failed to generate PDF.');
  }
});

// QR PNG
app.get('/kiosk/qr.png', async (req, res) => {
  const scanUrl = `${buildBaseUrl(req)}/kiosk/scan`;
  const buf = await makeQrPngBuffer(scanUrl);
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', 'inline; filename="kiosk-qr.png"');
  res.send(buf);
});

// DEBUG: chosen ad & redirect
app.get('/kiosk/debug', (req, res) => {
  const qa = (req.query.ad || '').trim();
  const n = /^[1-7]$/.test(qa) ? qa : FORCED;
  const target = new URL(GAME_URL);
  target.searchParams.set('ad', n);
  target.searchParams.set('pack', `ad${n}`);
  target.searchParams.set('t', Date.now().toString());
  res.type('text/plain').send(
    `FORCE_AD=${FORCE_AD || '(unset -> default 3)'}\n` +
    `override(ad query)=${qa || '(none)'}\n` +
    `selectedAd=${n}\n` +
    `redirect=${target.toString()}\n`
  );
});

// SCAN: check cooldown -> count -> redirect (hard force, optional ?ad override)
app.get('/kiosk/scan', async (req, res) => {
  const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
  
  // Check if this IP scanned recently
  if (isRecentScan(clientIP)) {
    const remainingMinutes = getRemainingCooldown(clientIP);
    
    const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Flashka - Please Wait</title>
<link href="https://fonts.googleapis.com/css2?family=Bangers&display=swap" rel="stylesheet">
<style>
  body{margin:0;background:#f6f6f6;color:#111;font-family:Arial,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .wrap{max-width:500px;background:#fff;border-radius:20px;padding:30px;text-align:center;box-shadow:0 10px 36px rgba(0,0,0,.08)}
  .title{font-family:'Bangers',sans-serif;font-size:48px;color:#d32f2f;margin-bottom:20px}
  .message{font-size:18px;line-height:1.6;margin-bottom:15px}
  .time{font-size:24px;font-weight:bold;color:#28a745;margin-bottom:20px}
  .note{font-size:14px;color:#666}
</style>
</head><body>
  <div class="wrap">
    <div class="title">Thanks for Playing!</div>
    <div class="message">You can play Flashka again in:</div>
    <div class="time">${remainingMinutes} minute${remainingMinutes !== 1 ? 's' : ''}</div>
    <div class="note">Enjoy your coffee!</div>
  </div>
</body></html>`;
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    return res.send(html);
  }
  
  // Record this scan and proceed
  recordScan(clientIP);
  
  await store.bumpScan();
  await store.bumpRedirect();

  const qa = (req.query.ad || '').trim();      // optional test override
  const n = /^[1-7]$/.test(qa) ? qa : FORCED;  // default to FORCED (MAFS=3)
  const target = new URL(GAME_URL);
  target.searchParams.set('ad', n);
  target.searchParams.set('pack', `ad${n}`);
  target.searchParams.set('t', Date.now().toString()); // cache-bust static site

  console.log(`[scan] IP=${clientIP} FORCE_AD=${FORCE_AD || '(unset->3)'} override=${qa || '-'} -> ad=${n}; redirect=${target.toString()}`);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return res.redirect(302, target.toString());
});

// STATS
app.get('/kiosk/stats', async (req, res) => {
  if (requireAdmin(req, res)) return;
  const rows = await store.getMetricsRows();
  const body = rows.length
    ? rows.map(r => `<tr><td>${r.day}</td><td style="text-align:right">${r.qr_scans||0}</td><td style="text-align:right">${r.redirects||0}</td></tr>`).join('')
    : '<tr><td colspan="3" style="text-align:center;color:#777">No data yet</td></tr>';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html><html><head><title>Kiosk Stats</title></head><body>
  <h1>Flashka — Kiosk Stats</h1>
  <table border="1" cellpadding="5"><tr><th>Date</th><th>Scans</th><th>Redirects</th></tr>${body}</table>
  </body></html>`);
});
app.get('/kiosk/stats.json', async (req, res) => {
  if (requireAdmin(req, res)) return;
  res.json(await store.getMetrics());
});
app.get('/kiosk/stats.csv', async (req, res) => {
  if (requireAdmin(req, res)) return;
  const rows = await store.getMetricsRows();
  let csv = 'date,qr_scans,redirects\n';
  for (const r of rows) csv += `${r.day},${r.qr_scans||0},${r.redirects||0}\n`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="kiosk-stats.csv"');
  res.send(csv);
});

// Root -> poster
app.get('/', (req, res) => res.redirect('/kiosk'));

/* ------------- BOOT ------------- */
(async () => {
  if (store.init) await store.init();
  app.listen(PORT, () => {
    console.log(`Kiosk :${PORT}  GAME_URL=${GAME_URL}  FORCE_AD=${FORCED} (env=${FORCE_AD || 'unset'})`);
  });
})();