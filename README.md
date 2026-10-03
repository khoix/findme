# findme

A small self-hosted location receiver and interactive map for an iOS Shortcut.

## Features

- `POST /findme/` accepts location updates.
- Optional image upload with each point: front camera, back camera, or screenshot.
- `GET /findme/` displays received points on an interactive Leaflet/OpenStreetMap map.
- Clicking a point shows:
  - latitude and longitude
  - battery percentage
  - timestamp
  - front/back camera images or screenshot, when uploaded
- `GET /findme/api/locations` returns recent location history.
- Bearer-token authentication for POSTs.
- HTTP Basic authentication for the map, API, and screenshots.
- Location history and screenshots are stored under `data/`, which is excluded from Git.

## Install

```bash
git clone https://github.com/khoix/findme.git
cd findme
npm install
cp .env.example .env
```

Edit `.env` before running either mode below.

## Running

`server.cjs` exports a mount-relative Express app and does not listen on its own,
so the same code serves both modes and all generated links adapt to the prefix
the app is mounted under.

### Mounted in main-server (recommended)

`main-server.js` already mounts it:

```javascript
const findmeApp = require('../findme/server.cjs');
app.use('/findme', mountedAppEnabledGate('/findme'), findmeApp);
```

It is served at `/findme` on the main server, and can be toggled on and off from
App Admin like the other mounted apps. If `.env` is missing or incomplete the
mount fails on its own and main-server serves a 503 at `/findme` rather than
failing to boot.

Because screenshots can be up to 12 MB, main-server skips its global body
parsers for `/findme` and lets this app parse its own request bodies.

### Standalone

```bash
npm start
```

This runs `standalone.cjs`, which mounts the app under `/findme` and listens on
`127.0.0.1:3210`. Set `FINDME_BASE_PATH` to serve it under a different prefix.
Do not run this at the same time as the main-server mount — both write to the
same `data/` directory.

## iOS Shortcut

Configure **Get Contents of URL**:

- URL: `https://www.khoix.net/findme/`
- Method: `POST`
- Header: `Authorization: Bearer YOUR_LONG_RANDOM_TOKEN`

### Without a screenshot

JSON is still supported:

```json
{
  "latitude": 35.123456,
  "longitude": -78.123456,
  "timestamp": "2026-10-02T21:58:37-04:00",
  "battery": 74
}
```

### With images

JSON may include these optional Base64 text fields:

| Field | Meaning |
| --- | --- |
| `front` | front-camera image |
| `back` | back-camera image |
| `screenshot` | screenshot image |

The server accepts **at most two images per update**. Supported combinations are:

- `front` + `back`
- `front` + `screenshot`
- any single one of the three

`back` and `screenshot` cannot be sent together in the same update.

## Map behavior

The map is interactive. Every received location is plotted as a clickable point and the points are connected as a route.

Clicking a point opens a popup showing:

- latitude and longitude
- battery level
- received/device timestamp
- any front, back, and/or screenshot images attached to that point

The map refreshes every 10 seconds.

## Reverse proxy

When mounted in main-server, FindMe is reached through the existing main-server
proxy block and needs no configuration of its own.

For standalone runs, see `deploy/nginx.conf.example`:

```nginx
location /findme/ {
    proxy_pass http://127.0.0.1:3210;
    client_max_body_size 16m;
}
```

## Test without screenshot

```bash
curl -X POST https://www.khoix.net/findme/ \
  -H 'Authorization: Bearer YOUR_LONG_RANDOM_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"latitude":35.7796,"longitude":-78.6382,"timestamp":"2026-10-02T21:58:37-04:00","battery":74}'
```

## Test with screenshot

```bash
curl -X POST https://www.khoix.net/findme/ \
  -H 'Authorization: Bearer YOUR_LONG_RANDOM_TOKEN' \
  -F 'latitude=35.7796' \
  -F 'longitude=-78.6382' \
  -F 'timestamp=2026-10-02T21:58:37-04:00' \
  -F 'battery=74' \
  -F 'screenshot=@screenshot.png'
```

A successful response looks like:

```json
{"ok":true,"screenshot":true}
```

## Security

- Never commit the real Bearer token or map password.
- Keep Node bound to localhost.
- Use HTTPS externally.
- `.env`, location history, and screenshots are excluded from Git.
- Screenshot files are only served through the authenticated map endpoint.
