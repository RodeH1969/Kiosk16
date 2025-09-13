// server.js – Kiosk poster + tracking + hard-force ad pack + scan cooldown (File storage only)

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');

const app = express();

/* ------------ CONFIG ------------ */
const PORT = process.env.PORT || 3030;
const ADMIN_KEY = process.env.ADMIN_KEY || null;
const GAME_URL = process.env.GAME_URL || 'https://flashka16.onrender.com';

// HARD FORCE: set 1..8 via env; if unset/invalid, default to 3 (MAFS)
const FORCE_AD = (process.env.FORCE_AD || '3').trim();
const FORCED = /^[1-8]$/.test(FORCE_AD) ? FORCE_AD : '3';

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
function requireAdmin(req, res) {
  if (!ADMIN_KEY) return null;
  if ((req.query.key || '') === ADMIN_KEY) return null;
  res.status(401).send('Unauthorized. Append ?key=YOUR_ADMIN_KEY to the URL.');
  return 'blocked';
}

/* -------- STORAGE (FILE ONLY) ----- */
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

const store = fileStore();

/* ----------- SCAN COOLDOWN ----------- */
const SCAN_COOLDOWN_MINUTES = 15; // 15 minutes between scans per IP
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
// Poster page
app.get('/kiosk', async (req, res) => {
  const scanUrl = `${buildBaseUrl(req)}/kiosk/scan`;
  const dataUrl = await QRCode.toDataURL(scanUrl, { errorCorrectionLevel: 'M', margin: 1, scale: 10 });

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Flashka – Scan to Play</title>
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

// QR PNG
app.get('/kiosk/qr.png', async (req, res) => {
  const scanUrl = `${buildBaseUrl(req)}/kiosk/scan`;
  const buf = await QRCode.toBuffer(scanUrl, { errorCorrectionLevel: 'M', margin: 1, scale: 10 });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', 'inline; filename="kiosk-qr.png"');
  res.send(buf);
});

// SCAN: check cooldown -> count -> redirect
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

  const qa = (req.query.ad || '').trim();
  const n = /^[1-8]$/.test(qa) ? qa : FORCED;
  const target = new URL(GAME_URL);
  target.searchParams.set('ad', n);
  target.searchParams.set('pack', `ad${n}`);
  target.searchParams.set('t', Date.now().toString());

  console.log(`[scan] IP=${clientIP} FORCE_AD=${FORCE_AD || '(unset->3)'} -> ad=${n}; redirect=${target.toString()}`);
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
  <h1>Flashka – Kiosk Stats</h1>
  <table border="1" cellpadding="5"><tr><th>Date</th><th>Scans</th><th>Redirects</th></tr>${body}</table>
  </body></html>`);
});

// Root -> poster
app.get('/', (req, res) => res.redirect('/kiosk'));

/* ------------- BOOT ------------- */
app.listen(PORT, () => {
  console.log(`Kiosk :${PORT}  GAME_URL=${GAME_URL}  FORCE_AD=${FORCED} (env=${FORCE_AD || 'unset'})`);
});