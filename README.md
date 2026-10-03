# findme

A small self-hosted location receiver and interactive map for an iOS Shortcut.

## Features

- `POST /findme/` accepts location updates.
- Optional screenshot upload with each point.
- `GET /findme/` displays received points on an interactive Leaflet/OpenStreetMap map.
- Clicking a point shows:
  - latitude and longitude
  - battery percentage
  - timestamp
  - screenshot, when one was uploaded
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

Edit `.env`, then start:

```bash
npm start
```

The app listens on `127.0.0.1:3210` by default.

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

### With a screenshot

Change **Request Body** from **JSON** to **Form** and add these fields:

| Field | Shortcut value |
| --- | --- |
| `latitude` | Current Location → Latitude |
| `longitude` | Current Location → Longitude |
| `timestamp` | Current Date / formatted date |
| `battery` | Battery Level |
| `screenshot` | output of **Take Screenshot** |

The screenshot field name must be exactly `screenshot`.

For the current automation, keep **Take Screenshot** inside the unlocked branch. When no screenshot is available, you can either omit the `screenshot` form field or post the metadata as JSON.

## Map behavior

The map is interactive. Every received location is plotted as a clickable point and the points are connected as a route.

Clicking a point opens a popup showing:

- latitude and longitude
- battery level
- received/device timestamp
- screenshot thumbnail when available

The map refreshes every 10 seconds.

## Reverse proxy

See `deploy/nginx.conf.example`.

```nginx
location /findme/ {
    proxy_pass http://127.0.0.1:3210;
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
