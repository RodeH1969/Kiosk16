// server.js — Kiosk poster + daily scan tracking + PDF + FORCE_AD override

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const QRCode = require('qrcode');
const { Pool } = require('pg');

const app = express();

/* ------------------ CONFIG ------------------ */
const PORT = process.env.PORT || 3030;
const ADMIN_KEY = process.env.ADMIN_KEY || null;
const DATABASE_URL = process.env.DATABASE_URL || null;
const GAME_URL = process.env.GAME_URL || 'https://flashka.onrender.com';
// One-change ad control: set 1..7 to force a specific pack (blank = weekday rotation)
const FORCE_AD = (process.env.FORCE_AD || '').trim();

/* ------------------ STATIC ------------------ */
const PUBLIC_DIR = path.join(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));
app.use(express.json());

/* --------------- TIME / HELPERS -------------- */
const BRIS_TZ = 'Australia/Brisbane';
const DOW_TO_AD = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 };

function dayKeyBrisbane(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: BRIS_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}
function buildBaseUrl(req) {
  return `${req.protocol}://${req.get('host')}`;
}
async function makeQrPngBuffer(text, opts = {}) {
  return QRCode.toBuffer(text, { errorCorrectionLevel: 'M', margin: 1, scale: 10, ...opts });
}
function requireAdmin(req, res) {
  if (!ADMIN_KEY) return null;
  if ((req.query.key || '') === ADMIN_KEY) return null;
  res.status(401).send('Unauthorized. Append ?key=YOUR_ADMIN_KEY to the URL.');
  return 'blocked';
}
function pickAd() {
  if (/^[1-7]$/.test(FORCE_AD)) return FORCE_AD; // forced value
  const weekday = new Intl.DateTimeFormat('en-AU', { timeZone: BRIS_TZ, weekday: 'short' }).format(new Date());
  return String(DOW_TO_AD[weekday] || 1);
}

/* --------------- STORAGE (PG/JSON) -------------- */
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

const store = DATABASE_URL ? pgStore() : fileStore();

/* --------------- ROUTES -------------- */
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
  .lines .big.with-choccy .title{
    font-family:'Bangers',system-ui,Arial,Helvetica,sans-serif;color:#d32f2f;font-weight:700;letter-spacing:.5px;text-transform:uppercase;line-height:1;
  }
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

// PDF export of the poster
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

// Debug: see chosen ad and final redirect
app.get('/kiosk/debug', (req, res) => {
  const n = pickAd();
  const target = new URL(GAME_URL);
  target.searchParams.set('ad', n);
  target.searchParams.set('pack', `ad${n}`);
  target.searchParams.set('t', Date.now().toString());
  res.type('text/plain').send(
    `FORCE_AD=${FORCE_AD || '(none)'}\n` +
    `selectedAd=${n}\n` +
    `redirect=${target.toString()}\n`
  );
});

// Scan: count then redirect, always adding ?ad & ?pack & cache-buster
app.get('/kiosk/scan', async (req, res) => {
  await store.bumpScan();
  await store.bumpRedirect();
  const n = pickAd();
  const target = new URL(GAME_URL);
  target.searchParams.set('ad', n);
  target.searchParams.set('pack', `ad${n}`);
  target.searchParams.set('t', Date.now().toString()); // cache-bust the game index
  console.log(`[scan] FORCE_AD=${FORCE_AD || '(none)'} -> ad=${n}; redirect=${target.toString()}`);
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return res.redirect(302, target.toString());
});

// Stats
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

/* ------------------ BOOT ------------------ */
(async () => {
  if (store.init) await store.init();
  app.listen(PORT, () => {
    console.log(`Kiosk running on :${PORT} — GAME_URL=${GAME_URL} — FORCE_AD=${FORCE_AD || '(weekday rotation)'}`);
  });
})();
