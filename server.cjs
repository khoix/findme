const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');

// Resolve .env next to this file so the app works when main-server requires it
// from a different working directory.
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();
const POST_TOKEN = process.env.FINDME_POST_TOKEN;
const VIEW_USER = process.env.FINDME_VIEW_USER;
const VIEW_PASSWORD = process.env.FINDME_VIEW_PASSWORD;

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'locations.jsonl');
const REQUEST_LOG_FILE = path.join(DATA_DIR, 'requests.jsonl');
const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');
const ASSET_DIR = path.join(__dirname, 'assets');
const IMAGE_FIELDS = ['front', 'back', 'screenshot'];

// Throwing rather than exiting keeps a missing .env from taking down main-server;
// the mount is wrapped in a try/catch that serves a 503 placeholder instead.
if (!POST_TOKEN || !VIEW_USER || !VIEW_PASSWORD) {
  throw new Error('Missing FINDME_POST_TOKEN, FINDME_VIEW_USER, or FINDME_VIEW_PASSWORD');
}

fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

app.disable('x-powered-by');

/** Public path prefix: '' standalone, '/findme' when mounted in main-server. */
function mountBase(req) {
  return req.baseUrl || '';
}

/** Records store a bare filename; older records stored a fully-qualified path. */
function screenshotUrl(base, stored) {
  if (!stored) return null;
  const filename = path.basename(stored);
  return `${base}/screenshots/${filename}`;
}

/** Behind nginx and main-server the socket address is always loopback. */
function clientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket?.remoteAddress || null;
}

function writeRequestLog(entry) {
  console.log(
    `FindMe POST ${entry.path} -> ${entry.status ?? 'aborted'} ` +
    `(${entry.durationMs}ms, ${entry.ip || 'unknown ip'})`
  );

  fs.promises
    .appendFile(REQUEST_LOG_FILE, JSON.stringify(entry) + '\n')
    .catch(err => console.error('FindMe: unable to write request log:', err.message));
}

/**
 * Logs every POST, including the ones rejected before the route runs (missing
 * or bad token, unsupported Content-Type) and the ones a client aborts
 * mid-upload. The route fills in body-shape details on req.requestLog when it
 * gets that far.
 */
function logPostRequests(req, res, next) {
  if (req.method !== 'POST') return next();

  const startedAt = Date.now();
  const authHeader = req.headers.authorization || '';
  const declaredLength = req.headers['content-length'];

  const entry = {
    receivedAt: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl,
    ip: clientIp(req),
    userAgent: req.headers['user-agent'] || null,
    contentType: req.headers['content-type'] || null,
    contentLength: declaredLength === undefined ? null : Number(declaredLength),
    // Scheme only; the credential itself must never reach the log.
    authScheme: authHeader ? authHeader.split(' ')[0] : null
  };

  req.requestLog = entry;

  // 'close' also covers aborted uploads, where 'finish' never fires.
  let written = false;
  const finalize = () => {
    if (written) return;
    written = true;
    entry.durationMs = Date.now() - startedAt;
    entry.completed = res.writableEnded;
    // An aborted request never sent a status; res.statusCode would still read 200.
    entry.status = res.writableEnded ? res.statusCode : null;
    writeRequestLog(entry);
  };

  res.on('finish', finalize);
  res.on('close', finalize);

  next();
}

app.use(logPostRequests);

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

function requireBearer(req, res, next) {
  if (req.headers.authorization !== `Bearer ${POST_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

const upload = multer({
  storage: multer.diskStorage({
    destination: SCREENSHOT_DIR,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() ||
        (file.mimetype === 'image/jpeg' ? '.jpg' :
         file.mimetype === 'image/heic' ? '.heic' :
         file.mimetype === 'image/webp' ? '.webp' : '.png');
      cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
    }
  }),
  // A FindMe update may contain front+back or front+screenshot, never 3 images.
  limits: { fileSize: 12 * 1024 * 1024, files: 2 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('Uploaded file must be an image'));
    }
    cb(null, true);
  }
});

function uploadedFiles(req) {
  if (!req.files) return [];
  return Object.values(req.files).flat().filter(Boolean);
}

function removeUploadedFiles(req) {
  for (const file of uploadedFiles(req)) {
    fs.promises.unlink(file.path).catch(() => {});
  }
}

function parseIncoming(req, res, next) {
  if (req.is('multipart/form-data')) {
    const fields = IMAGE_FIELDS.map(name => ({ name, maxCount: 1 }));
    return upload.fields(fields)(req, res, err => {
      if (err) {
        removeUploadedFiles(req);
        return res.status(400).json({ error: err.message });
      }
      next();
    });
  }

  if (req.is('application/json')) {
    // Two 12 MB images can expand to roughly 32 MB total when Base64 encoded.
    return express.json({ limit: '36mb' })(req, res, next);
  }

  return res.status(415).json({
    error: 'Content-Type must be application/json or multipart/form-data'
  });
}

function imageExtension(buffer, declaredMime) {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) return '.png';

  if (
    buffer.length >= 3 &&
    buffer[0] === 0xff &&
    buffer[1] === 0xd8 &&
    buffer[2] === 0xff
  ) return '.jpg';

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 0, 4) === 'RIFF' &&
    buffer.toString('ascii', 8, 12) === 'WEBP'
  ) return '.webp';

  if (
    buffer.length >= 12 &&
    buffer.toString('ascii', 4, 8) === 'ftyp'
  ) return '.heic';

  if (declaredMime === 'image/png') return '.png';
  if (declaredMime === 'image/jpeg') return '.jpg';
  if (declaredMime === 'image/webp') return '.webp';
  if (declaredMime === 'image/heic' || declaredMime === 'image/heif') return '.heic';

  return null;
}

async function saveBase64Image(value, fieldName = 'image') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${fieldName} must be Base64 text`);

  let base64 = value.trim();
  let declaredMime = null;

  const dataUrl = base64.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.*)$/s);
  if (dataUrl) {
    declaredMime = dataUrl[1].toLowerCase();
    base64 = dataUrl[2];
  }

  base64 = base64.replace(/\s+/g, '');
  if (!base64) return null;

  const buffer = Buffer.from(base64, 'base64');

  if (!buffer.length) throw new Error(`${fieldName} contains invalid Base64 data`);
  if (buffer.length > 12 * 1024 * 1024) throw new Error(`${fieldName} exceeds 12 MB`);

  const ext = imageExtension(buffer, declaredMime);
  if (!ext) throw new Error(`${fieldName} is not a supported image`);

  const filename = `${Date.now()}-${crypto.randomUUID()}${ext}`;
  await fs.promises.writeFile(path.join(SCREENSHOT_DIR, filename), buffer);

  return { filename };
}

app.post('/', requireBearer, parseIncoming, async (req, res) => {
  const body = req.body || {};

  const imageBodyState = Object.fromEntries(
    IMAGE_FIELDS.map(name => {
      const value = body[name];
      return [name, {
        present: Object.prototype.hasOwnProperty.call(body, name),
        type: typeof value,
        length: typeof value === 'string' ? value.length : null
      }];
    })
  );

  if (req.requestLog) {
    Object.assign(req.requestLog, {
      keys: Object.keys(body),
      images: imageBodyState,
      uploadedFiles: uploadedFiles(req).map(file => ({
        field: file.fieldname,
        filename: file.filename,
        size: file.size
      }))
    });
  }

  // Accept both the concise iOS Shortcut field names and the longer API names.
  const latitude = body.lat ?? body.latitude;
  const longitude = body.lon ?? body.longitude;
  const timestamp = body.time ?? body.timestamp;
  const battery = body.bat ?? body.battery;

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
    removeUploadedFiles(req);
    return res.status(400).json({ error: 'Invalid latitude or longitude' });
  }

  if (
    batt !== null &&
    (!Number.isFinite(batt) || batt < 0 || batt > 100)
  ) {
    removeUploadedFiles(req);
    return res.status(400).json({ error: 'Invalid battery level' });
  }

  const multipartByField = Object.fromEntries(
    IMAGE_FIELDS.map(name => [name, req.files?.[name]?.[0] || null])
  );

  const activeImageFields = IMAGE_FIELDS.filter(name => {
    if (multipartByField[name]) return true;
    const value = body[name];
    return typeof value === 'string'
      ? value.trim().length > 0
      : value !== undefined && value !== null;
  });

  if (activeImageFields.length > 2) {
    removeUploadedFiles(req);
    return res.status(400).json({
      error: 'At most two images may be sent per update'
    });
  }

  if (activeImageFields.includes('back') && activeImageFields.includes('screenshot')) {
    removeUploadedFiles(req);
    return res.status(400).json({
      error: 'back and screenshot are mutually exclusive; send front+back or front+screenshot'
    });
  }

  const images = {};
  const base64Saved = [];

  try {
    for (const name of IMAGE_FIELDS) {
      const uploaded = multipartByField[name];

      if (uploaded) {
        images[name] = { filename: uploaded.filename };
        continue;
      }

      const value = body[name];
      if (typeof value === 'string' && value.trim()) {
        const saved = await saveBase64Image(value, name);
        if (saved) {
          images[name] = saved;
          base64Saved.push(saved);
        }
      }
    }

    const point = {
      latitude: lat,
      longitude: lon,
      timestamp: timestamp || null,
      battery: batt,
      front: images.front ? images.front.filename : null,
      back: images.back ? images.back.filename : null,
      screenshot: images.screenshot ? images.screenshot.filename : null,
      receivedAt: new Date().toISOString()
    };

    await fs.promises.appendFile(DATA_FILE, JSON.stringify(point) + '\n');

    res.json({
      ok: true,
      front: Boolean(images.front),
      back: Boolean(images.back),
      screenshot: Boolean(images.screenshot)
    });
  } catch (err) {
    removeUploadedFiles(req);

    for (const image of base64Saved) {
      fs.promises.unlink(path.join(SCREENSHOT_DIR, image.filename)).catch(() => {});
    }

    console.error(err);
    res.status(400).json({ error: err.message || 'Unable to save location' });
  }
});

app.get('/favicon.png', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('png').sendFile(path.join(ASSET_DIR, 'favicon.png'));
});

app.get('/apple-touch-icon.png', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.type('png').sendFile(path.join(ASSET_DIR, 'apple-touch-icon.png'));
});

app.get('/screenshots/:name', basicAuth, (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(SCREENSHOT_DIR, name);

  if (!fs.existsSync(file)) return res.status(404).send('Not found');

  res.set('Cache-Control', 'private, no-store');
  res.sendFile(file);
});

app.get('/api/locations', basicAuth, async (req, res) => {
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

    const base = mountBase(req);

    res.json(points.map(point => ({
      ...point,
      front: screenshotUrl(base, point.front),
      back: screenshotUrl(base, point.back),
      screenshot: screenshotUrl(base, point.screenshot)
    })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to read locations' });
  }
});

app.get('/', basicAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');

  const base = mountBase(req);

  res.type('html').send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FindMe</title>
<link rel="icon" type="image/png" href="${base}/favicon.png">
<link rel="apple-touch-icon" sizes="180x180" href="${base}/apple-touch-icon.png">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<style>
html,body,#map{height:100%;margin:0}
body{font-family:system-ui,sans-serif;background:#111}
#status{position:fixed;z-index:1000;top:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.82);color:#fff;padding:7px 12px;border-radius:8px;font-size:13px;white-space:nowrap}
.popup-shot{display:block;width:280px;max-width:100%;height:auto;margin-top:4px;border-radius:6px}
.popup-image{margin-top:8px}
.popup-image-label{font-size:12px;font-weight:600;margin-bottom:2px}
.popup-meta{line-height:1.45}
</style>
</head>
<body>
<div id="status">Loading…</div>
<div id="map"></div>
<div id="image-viewer" aria-hidden="true">
  <button id="image-viewer-close" type="button" aria-label="Close image">×</button>
  <img id="image-viewer-img" alt="">
</div>

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

const imageViewer = document.getElementById('image-viewer');
const imageViewerImg = document.getElementById('image-viewer-img');
const imageViewerClose = document.getElementById('image-viewer-close');

function openImageViewer(src, alt) {
  imageViewerImg.src = src;
  imageViewerImg.alt = alt || 'Location image';
  imageViewer.classList.add('open');
  imageViewer.setAttribute('aria-hidden', 'false');
}

function closeImageViewer() {
  imageViewer.classList.remove('open');
  imageViewer.setAttribute('aria-hidden', 'true');
  imageViewerImg.removeAttribute('src');
}

document.addEventListener('click', event => {
  const image = event.target.closest?.('.popup-shot');
  if (image) {
    event.preventDefault();
    event.stopPropagation();
    openImageViewer(image.src, image.alt);
  }
});

imageViewerClose.addEventListener('click', event => {
  event.stopPropagation();
  closeImageViewer();
});

imageViewer.addEventListener('click', event => {
  if (event.target === imageViewer) closeImageViewer();
});

document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && imageViewer.classList.contains('open')) {
    closeImageViewer();
  }
});

async function refresh() {
  try {
    const response = await fetch('${base}/api/locations', { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);

    const points = await response.json();

    const openPopupMarker = markers.find(marker => marker.isPopupOpen());
    const openPopupKey = openPopupMarker ? openPopupMarker._findmeKey : null;

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
      const pointKey = point.receivedAt ||
        [point.latitude, point.longitude, point.timestamp, index].join('|');

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

      const imageItems = [
        ['Front', point.front],
        ['Back', point.back],
        ['Screenshot', point.screenshot]
      ].filter(([, url]) => Boolean(url));

      const images = imageItems.length
        ? imageItems.map(([label, url]) =>
            '<div class="popup-image">' +
              '<div class="popup-image-label">' + escapeHtml(label) + '</div>' +
              '<img class="popup-shot" src="' + escapeHtml(url) + '" alt="' + escapeHtml(label) + '">' +
            '</div>'
          ).join('')
        : '<div style="margin-top:8px"><em>No images</em></div>';

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
          images +
        '</div>',
        { maxWidth: 320 }
      );

      marker._findmeKey = pointKey;
      marker.addTo(map);
      markers.push(marker);

      if (openPopupKey && openPopupKey === pointKey) {
        marker.openPopup();
      }
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

// Export the Express app for mounting (main-server.js mounts this under /findme).
module.exports = app;
