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

const SESSION_COOKIE = 'findme_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_KEY = crypto
  .createHash('sha256')
  .update(`${VIEW_PASSWORD}\0${POST_TOKEN}`)
  .digest();

function safeEqualText(actual, expected) {
  const a = Buffer.from(String(actual ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function cookieMap(req) {
  const header = req.headers.cookie || '';
  const cookies = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function signSessionPayload(payload) {
  return crypto
    .createHmac('sha256', SESSION_KEY)
    .update(payload)
    .digest('base64url');
}

function createSessionToken() {
  const payload = Buffer.from(JSON.stringify({
    user: VIEW_USER,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000
  }), 'utf8').toString('base64url');

  return `${payload}.${signSessionPayload(payload)}`;
}

function hasValidViewSession(req) {
  const token = cookieMap(req)[SESSION_COOKIE];
  if (!token) return false;

  const separator = token.lastIndexOf('.');
  if (separator <= 0) return false;

  const payload = token.slice(0, separator);
  const suppliedSignature = token.slice(separator + 1);
  const expectedSignature = signSessionPayload(payload);

  if (!safeEqualText(suppliedSignature, expectedSignature)) return false;

  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return session.user === VIEW_USER &&
      Number.isFinite(session.expiresAt) &&
      session.expiresAt > Date.now();
  } catch {
    return false;
  }
}

function sessionCookiePath(req) {
  return mountBase(req) || '/';
}

function isHttpsRequest(req) {
  const forwarded = req.headers['x-forwarded-proto'];
  const proto = typeof forwarded === 'string'
    ? forwarded.split(',')[0].trim().toLowerCase()
    : '';
  return req.secure || proto === 'https';
}

function setViewSession(req, res) {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(createSessionToken())}`,
    `Path=${sessionCookiePath(req)}`,
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${SESSION_TTL_SECONDS}`
  ];

  if (isHttpsRequest(req)) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearViewSession(req, res) {
  const attributes = [
    `${SESSION_COOKIE}=`,
    `Path=${sessionCookiePath(req)}`,
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];

  if (isHttpsRequest(req)) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function requireViewPage(req, res, next) {
  if (hasValidViewSession(req)) return next();
  const base = mountBase(req);
  return res.redirect(302, `${base}/login`);
}

function requireViewSession(req, res, next) {
  if (hasValidViewSession(req)) return next();
  return res.status(401).json({ error: 'Authentication required' });
}

function requireImageSession(req, res, next) {
  if (hasValidViewSession(req)) return next();
  return res.status(401).send('Authentication required');
}

function loginPage(base, invalid = false) {
  const error = invalid
    ? '<div class="login-error" role="alert">Incorrect username or password.</div>'
    : '';

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#087cf0">
<title>FindMe Login</title>
<link rel="icon" type="image/png" href="${base}/favicon.png">
<link rel="apple-touch-icon" sizes="180x180" href="${base}/apple-touch-icon.png">
<style>
*{box-sizing:border-box}
html,body{min-height:100%;margin:0}
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 50% 15%,#43c7ff 0,#0a83f5 32%,#0756dc 68%,#0632a7 100%);color:#132037;display:flex;align-items:center;justify-content:center;padding:max(24px,env(safe-area-inset-top)) 20px max(24px,env(safe-area-inset-bottom))}
.login-card{width:min(100%,390px);padding:32px 28px 28px;border-radius:28px;background:rgba(255,255,255,.94);box-shadow:0 24px 70px rgba(0,20,90,.35);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
.login-icon{display:block;width:104px;height:104px;object-fit:cover;margin:-4px auto 18px;border-radius:24px;box-shadow:0 12px 28px rgba(0,70,180,.22)}
h1{font-size:28px;line-height:1.05;text-align:center;margin:0 0 8px}
.login-subtitle{text-align:center;color:#5b6779;font-size:14px;margin:0 0 26px}
.login-field{display:block;margin:0 0 15px}
.login-label{display:block;font-size:13px;font-weight:650;margin:0 0 6px;color:#354155}
.login-input{width:100%;height:50px;border:1px solid #ccd5e2;border-radius:14px;padding:0 15px;font:16px system-ui;background:#fff;color:#142033;outline:none;transition:border-color .15s,box-shadow .15s}
.login-input:focus{border-color:#0b7ff0;box-shadow:0 0 0 4px rgba(11,127,240,.13)}
.login-button{width:100%;height:50px;border:0;border-radius:14px;margin-top:5px;background:linear-gradient(180deg,#1495ff,#096be8);color:#fff;font:700 16px system-ui;box-shadow:0 8px 20px rgba(8,104,225,.3);cursor:pointer}
.login-button:active{transform:translateY(1px)}
.login-error{background:#fff0f0;border:1px solid #ffc9c9;color:#a82121;border-radius:12px;padding:10px 12px;margin:0 0 15px;font-size:13px}
.login-note{text-align:center;color:#758196;font-size:12px;margin:18px 0 0}
</style>
</head>
<body>
<main class="login-card">
  <img class="login-icon" src="${base}/apple-touch-icon.png" alt="">
  <h1>FindMe</h1>
  <p class="login-subtitle">Sign in to view location history.</p>
  ${error}
  <form method="post" action="${base}/login" autocomplete="on">
    <label class="login-field">
      <span class="login-label">Username</span>
      <input class="login-input" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus>
    </label>
    <label class="login-field">
      <span class="login-label">Password</span>
      <input class="login-input" name="password" type="password" autocomplete="current-password" required>
    </label>
    <button class="login-button" type="submit">Sign In</button>
  </form>
  <p class="login-note">Private location dashboard</p>
</main>
</body>
</html>`;
}

const loginBodyParser = express.urlencoded({ extended: false, limit: '4kb' });

app.get('/login', (req, res) => {
  const base = mountBase(req);
  if (hasValidViewSession(req)) return res.redirect(302, `${base}/`);
  res.set('Cache-Control', 'no-store');
  res.type('html').send(loginPage(base, req.query.invalid === '1'));
});

app.post('/login', loginBodyParser, (req, res) => {
  const base = mountBase(req);
  const username = req.body?.username ?? '';
  const password = req.body?.password ?? '';

  if (!safeEqualText(username, VIEW_USER) || !safeEqualText(password, VIEW_PASSWORD)) {
    return res.redirect(303, `${base}/login?invalid=1`);
  }

  setViewSession(req, res);
  return res.redirect(303, `${base}/`);
});

app.post('/logout', (req, res) => {
  const base = mountBase(req);
  clearViewSession(req, res);
  return res.redirect(303, `${base}/login`);
});

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

app.get('/screenshots/:name', requireImageSession, (req, res) => {
  const name = path.basename(req.params.name);
  const file = path.join(SCREENSHOT_DIR, name);

  if (!fs.existsSync(file)) return res.status(404).send('Not found');

  res.set('Cache-Control', 'private, no-store');
  res.sendFile(file);
});

app.get('/api/locations', requireViewSession, async (req, res) => {
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

app.get('/', requireViewPage, (req, res) => {
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
#logout-form{position:fixed;z-index:1001;right:10px;bottom:max(12px,env(safe-area-inset-bottom));margin:0}
#logout-button{border:0;border-radius:999px;background:rgba(0,0,0,.72);color:#fff;padding:8px 11px;font:600 12px system-ui;box-shadow:0 2px 9px rgba(0,0,0,.25);cursor:pointer}
.popup-shot{display:block;width:176px;height:176px;object-fit:cover;border-radius:8px;cursor:zoom-in;-webkit-user-select:none;user-select:none}
.popup-meta{line-height:1.4}
.image-carousel{width:176px;margin:9px auto 0}
.image-carousel-track{display:flex;width:176px;height:176px;overflow-x:auto;scroll-snap-type:x mandatory;scroll-behavior:smooth;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;touch-action:pan-x;scrollbar-width:none;border-radius:8px;background:#111}
.image-carousel-track::-webkit-scrollbar{display:none}
.image-slide{position:relative;flex:0 0 176px;width:176px;height:176px;scroll-snap-align:start;scroll-snap-stop:always}
.image-slide-label{position:absolute;z-index:2;left:7px;bottom:7px;margin:0;padding:3px 7px;border-radius:999px;background:rgba(0,0,0,.62);color:#fff;font-size:11px;font-weight:650;line-height:1.25;pointer-events:none}
.image-dots{display:flex;justify-content:center;align-items:center;gap:6px;height:18px;padding-top:5px}
.image-dot{width:7px;height:7px;padding:0;border:0;border-radius:50%;background:#a8a8a8;opacity:.45}
.image-dot.active{opacity:1;background:#555}
#image-viewer{position:fixed;inset:0;z-index:10000;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.96);padding:max(20px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));box-sizing:border-box}
#image-viewer.open{display:flex}
#image-viewer-img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}
#image-viewer-close{position:absolute;top:max(12px,env(safe-area-inset-top));right:max(12px,env(safe-area-inset-right));z-index:10001;width:44px;height:44px;border:0;border-radius:50%;background:rgba(40,40,40,.72);color:#fff;font:32px/40px system-ui,sans-serif;cursor:pointer;-webkit-tap-highlight-color:transparent}
</style>
</head>
<body>
<div id="status">Loading…</div>
<form id="logout-form" method="post" action="${base}/logout">
  <button id="logout-button" type="submit">Sign out</button>
</form>
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

function carouselSlideIndex(track) {
  if (!track || !track.clientWidth) return 0;
  return Math.max(0, Math.round(track.scrollLeft / track.clientWidth));
}

function updateCarouselDots(track) {
  if (!track) return;
  const carousel = track.closest('.image-carousel');
  if (!carousel) return;

  const index = carouselSlideIndex(track);
  carousel.querySelectorAll('.image-dot').forEach((dot, dotIndex) => {
    dot.classList.toggle('active', dotIndex === index);
    dot.setAttribute('aria-current', dotIndex === index ? 'true' : 'false');
  });
}

function initializeCarousel(root, initialSlide = 0) {
  const track = root?.querySelector('.image-carousel-track');
  if (!track) return;

  let scrollTimer;
  track.addEventListener('scroll', () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => updateCarouselDots(track), 40);
  }, { passive: true });

  track.addEventListener('click', event => {
    const dot = event.target.closest?.('.image-dot');
    if (!dot) return;

    const index = Number(dot.dataset.slide || 0);
    track.scrollTo({ left: track.clientWidth * index, behavior: 'smooth' });
  });

  requestAnimationFrame(() => {
    if (initialSlide > 0) {
      track.scrollLeft = track.clientWidth * initialSlide;
    }
    updateCarouselDots(track);
  });
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

document.addEventListener('pointerdown', event => {
  if (event.target.closest?.('.image-carousel')) {
    event.stopPropagation();
  }
}, true);

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
    const openPopupElement = openPopupMarker?.getPopup()?.getElement();
    const openPopupTrack = openPopupElement?.querySelector('.image-carousel-track');
    const openPopupSlide = carouselSlideIndex(openPopupTrack);

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
        ? '<div class="image-carousel">' +
            '<div class="image-carousel-track">' +
              imageItems.map(([label, url]) =>
                '<div class="image-slide">' +
                  '<div class="image-slide-label">' + escapeHtml(label) + '</div>' +
                  '<img class="popup-shot" src="' + escapeHtml(url) + '" alt="' + escapeHtml(label) + '">' +
                '</div>'
              ).join('') +
            '</div>' +
            (imageItems.length > 1
              ? '<div class="image-dots" aria-label="Image carousel position">' +
                  imageItems.map(([, url], dotIndex) =>
                    '<button type="button" class="image-dot' + (dotIndex === 0 ? ' active' : '') +
                    '" data-slide="' + dotIndex + '" aria-label="Show image ' + (dotIndex + 1) +
                    '" aria-current="' + (dotIndex === 0 ? 'true' : 'false') + '"></button>'
                  ).join('') +
                '</div>'
              : '') +
          '</div>'
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
        { maxWidth: 230, minWidth: 210 }
      );

      marker._findmeKey = pointKey;
      marker.on('popupopen', () => {
        const popupElement = marker.getPopup()?.getElement();
        initializeCarousel(
          popupElement,
          openPopupKey && openPopupKey === pointKey ? openPopupSlide : 0
        );
      });

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
