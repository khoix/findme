const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3210);
const POST_TOKEN = process.env.FINDME_POST_TOKEN;
const VIEW_USER = process.env.FINDME_VIEW_USER;
const VIEW_PASSWORD = process.env.FINDME_VIEW_PASSWORD;

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'locations.jsonl');
const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');

if (!POST_TOKEN || !VIEW_USER || !VIEW_PASSWORD) {
  console.error('Missing FINDME_POST_TOKEN, FINDME_VIEW_USER, or FINDME_VIEW_PASSWORD');
  process.exit(1);
}

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="FindMe"');
    return res.status(401).send('Authentication required');
  }

  let decoded = '';
  try {
    decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  } catch {
    return res.status(401).send('Invalid credentials');
  }

  const i = decoded.indexOf(':');
  if (i < 0) return res.status(401).send('Invalid credentials');

  const username = decoded.slice(0, i);
  const password = decoded.slice(i + 1);

  if (username !== VIEW_USER || password !== VIEW_PASSWORD) {
    return res.status(401).send('Invalid credentials');
  }

  next();
}

function validBearer(req) {
  return req.headers.authorization === `Bearer ${POST_TOKEN}`;
}

const upload = multer({
  storage: multer.diskStorage({
    destination: SCREENSHOT_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() ||
        (file.mimetype === 'image/jpeg' ? '.jpg' :
         file.mimetype === 'image/heic' ? '.heic' : '.png');
      cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: 12 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Screenshot must be an image'));
    }
    cb(null, true);
  }
});

function parseIncoming(req, res, next) {
  if (req.is('multipart/form-data')) {
    return upload.single('screenshot')(req, res, err => {
      if (err) return res.status(400).json({ error: err.message });
      next();
    });
  }
  next();
}

app.post('/findme/', parseIncoming, async (req, res) => {
  if (!validBearer(req)) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { latitude, longitude, timestamp, battery } = req.body || {};
  const lat = Number(latitude);
  const lon = Number(longitude);
  const batt =
    battery === undefined || battery === null || battery === ''
      ? null
      : Number(battery);

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Invalid latitude or longitude' });
  }

  if (
    batt !== null &&
    (!Number.isFinite(batt) || batt < 0 || batt > 100)
  ) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    return res.status(400).json({ error: 'Invalid battery level' });
  }

  const point = {
    latitude: lat,
    longitude: lon,
    timestamp: timestamp || null,
    battery: batt,
    screenshot: req.file ? `/findme/screenshots/${req.file.filename}` : null,
    receivedAt: new Date().toISOString()
  };

  try {
    await fs.promises.appendFile(DATA_FILE, JSON.stringify(point) + '\n');
    res.json({ ok: true, screenshot: Boolean(req.file) });
  } catch (err) {
    if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'Unable to save location' });
  }
});

app.get('/findme/screenshots/:name', basicAuth, (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(SCREENSHOT_DIR, name);

  if (!fs.existsSync(file)) return res.status(404).send('Not found');

  res.set('Cache-Control', 'private, no-store');
  res.sendFile(file);
});

app.get('/findme/api/locations', basicAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');

  try {
    if (!fs.existsSync(DATA_FILE)) return res.json([]);

    const contents = await fs.promises.readFile(DATA_FILE, 'utf8');

    const points = contents
      .split('\n')
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .slice(-1000);

    res.json(points);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to read locations' });
  }
});

app.get('/findme/', basicAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');

  res.type('html').send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FindMe</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
html,body,#map{height:100%;margin:0}
body{font-family:system-ui,sans-serif;background:#111}
#status{position:fixed;z-index:1000;top:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.82);color:#fff;padding:7px 12px;border-radius:8px;font-size:13px;white-space:nowrap}
.popup-shot{display:block;width:280px;max-width:100%;height:auto;margin-top:8px;border-radius:6px}
.popup-meta{line-height:1.45}
</style>
</head>
<body>
<div id="status">Loading…</div>
<div id="map"></div>

<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const map = L.map('map');

L.tileLayer(
  'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  {
    maxZoom: 19,
    attribution: '&copy; OpenStreetMap contributors'
  }
).addTo(map);

let route;
let markers = [];
let firstLoad = true;

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

async function refresh() {
  try {
    const response = await fetch('/findme/api/locations', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    const points = await response.json();

    markers.forEach(marker => map.removeLayer(marker));
    markers = [];

    if (route) map.removeLayer(route);

    if (!points.length) {
      document.getElementById('status').textContent = 'No location received yet';
      map.setView([35.7796, -78.6382], 11);
      return;
    }

    const coords = points.map(point => [point.latitude, point.longitude]);

    route = L.polyline(coords, {
      weight: 4,
      opacity: .65
    }).addTo(map);

    points.forEach((point, index) => {
      const latest = index === points.length - 1;

      const marker = L.circleMarker(
        [point.latitude, point.longitude],
        {
          radius: latest ? 9 : 5,
          weight: latest ? 3 : 1,
          fillOpacity: latest ? 1 : .65
        }
      );

      const time = point.timestamp || point.receivedAt;
      const latLon =
        Number(point.latitude).toFixed(6) + ', ' +
        Number(point.longitude).toFixed(6);

      const screenshot = point.screenshot
        ? '<img class="popup-shot" src="' + escapeHtml(point.screenshot) + '" alt="Screenshot">'
        : '<div style="margin-top:8px"><em>No screenshot</em></div>';

      marker.bindPopup(
        '<div class="popup-meta">' +
          '<strong>' + (latest ? 'Latest Location' : 'Location') + '</strong><br>' +
          '<strong>Lat, Lon:</strong> ' + escapeHtml(latLon) + '<br>' +
          '<strong>Battery:</strong> ' +
            (point.battery !== null && point.battery !== undefined
              ? escapeHtml(point.battery) + '%'
              : 'Unknown') +
          '<br><strong>Time:</strong> ' +
            escapeHtml(new Date(time).toLocaleString()) +
          screenshot +
        '</div>',
        { maxWidth: 320 }
      );

      marker.addTo(map);
      markers.push(marker);
    });

    const latest = points[points.length - 1];

    document.getElementById('status').textContent =
      'Last update: ' +
      new Date(latest.timestamp || latest.receivedAt).toLocaleString() +
      (latest.battery !== null && latest.battery !== undefined
        ? ' • Battery ' + latest.battery + '%'
        : '');

    if (firstLoad) {
      if (points.length === 1) {
        map.setView(coords[0], 17);
      } else {
        map.fitBounds(route.getBounds(), {
          padding: [40, 40],
          maxZoom: 17
        });
      }
      firstLoad = false;
    }
  } catch (err) {
    document.getElementById('status').textContent = 'Unable to load location';
    console.error(err);
  }
}

refresh();
setInterval(refresh, 10000);
</script>
</body>
</html>`);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`FindMe listening at http://127.0.0.1:${PORT}/findme/`);
});
