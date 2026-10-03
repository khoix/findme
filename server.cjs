const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = Number(process.env.PORT || 3210);
const POST_TOKEN = process.env.FINDME_POST_TOKEN;
const VIEW_USER = process.env.FINDME_VIEW_USER;
const VIEW_PASSWORD = process.env.FINDME_VIEW_PASSWORD;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'locations.jsonl');

if (!POST_TOKEN || !VIEW_USER || !VIEW_PASSWORD) {
  console.error('Missing FINDME_POST_TOKEN, FINDME_VIEW_USER, or FINDME_VIEW_PASSWORD');
  process.exit(1);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));

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

app.post('/findme/', async (req, res) => {
  if (!validBearer(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { latitude, longitude, timestamp, battery } = req.body;
  const lat = Number(latitude);
  const lon = Number(longitude);
  const batt = battery === undefined || battery === null || battery === '' ? null : Number(battery);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) ||
      lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return res.status(400).json({ error: 'Invalid latitude or longitude' });
  }

  if (batt !== null && (!Number.isFinite(batt) || batt < 0 || batt > 100)) {
    return res.status(400).json({ error: 'Invalid battery level' });
  }

  const point = {
    latitude: lat,
    longitude: lon,
    timestamp: timestamp || null,
    battery: batt,
    receivedAt: new Date().toISOString()
  };

  try {
    await fs.promises.appendFile(DATA_FILE, JSON.stringify(point) + '\n');
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Unable to save location' });
  }
});

app.get('/findme/api/locations', basicAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!fs.existsSync(DATA_FILE)) return res.json([]);
    const contents = await fs.promises.readFile(DATA_FILE, 'utf8');
    const points = contents.split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).slice(-1000);
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
#status{position:fixed;z-index:1000;top:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.8);color:#fff;padding:7px 12px;border-radius:8px;font-size:13px;white-space:nowrap}
</style>
</head>
<body>
<div id="status">Loading…</div><div id="map"></div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<script>
const map=L.map('map');
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; OpenStreetMap contributors'}).addTo(map);
let route,markers=[],firstLoad=true;
async function refresh(){
  try{
    const r=await fetch('/findme/api/locations',{cache:'no-store'});
    if(!r.ok) throw new Error('HTTP '+r.status);
    const points=await r.json();
    markers.forEach(m=>map.removeLayer(m)); markers=[];
    if(route) map.removeLayer(route);
    if(!points.length){
      document.getElementById('status').textContent='No location received yet';
      map.setView([35.7796,-78.6382],11);
      return;
    }
    const coords=points.map(p=>[p.latitude,p.longitude]);
    route=L.polyline(coords,{weight:4,opacity:.65}).addTo(map);
    points.forEach((p,index)=>{
      const latest=index===points.length-1;
      const marker=L.circleMarker([p.latitude,p.longitude],{radius:latest?9:4,weight:latest?3:1,fillOpacity:latest?1:.5});
      const time=p.timestamp||p.receivedAt;
      marker.bindPopup('<strong>'+(latest?'Latest Location':'Location')+'</strong><br>'+p.latitude.toFixed(6)+', '+p.longitude.toFixed(6)+'<br>'+new Date(time).toLocaleString()+(p.battery!==null?'<br>Battery: '+p.battery+'%':''));
      marker.addTo(map); markers.push(marker);
    });
    const latest=points[points.length-1];
    document.getElementById('status').textContent='Last update: '+new Date(latest.timestamp||latest.receivedAt).toLocaleString()+(latest.battery!==null?' • Battery '+latest.battery+'%':'');
    if(firstLoad){ map.fitBounds(route.getBounds(),{padding:[40,40],maxZoom:17}); firstLoad=false; }
  }catch(err){
    document.getElementById('status').textContent='Unable to load location';
    console.error(err);
  }
}
refresh(); setInterval(refresh,10000);
</script>
</body>
</html>`);
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`FindMe listening at http://127.0.0.1:${PORT}/findme/`);
});
