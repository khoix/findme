# findme

A small self-hosted location receiver and map for an iOS Shortcut.

## Features

- `POST /findme/` accepts location updates.
- `GET /findme/` displays recent points on a Leaflet/OpenStreetMap map.
- `GET /findme/api/locations` returns recent location history.
- Bearer-token authentication for POSTs.
- HTTP Basic authentication for the map/API.
- Location history stored locally in `data/locations.jsonl` and excluded from Git.

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
- Request Body: JSON

Example:

```json
{
  "latitude": 35.123456,
  "longitude": -78.123456,
  "timestamp": "2026-10-02T21:58:37-04:00",
  "battery": 74
}
```

Use Number fields for latitude, longitude, and battery, and Text for timestamp.

## Reverse proxy

See `deploy/nginx.conf.example`. Keep the upstream bound to localhost and expose it through HTTPS.

## Test

```bash
curl -X POST https://www.khoix.net/findme/ \
  -H 'Authorization: Bearer YOUR_LONG_RANDOM_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"latitude":35.7796,"longitude":-78.6382,"timestamp":"2026-10-02T21:58:37-04:00","battery":74}'
```

A successful request returns:

```json
{"ok":true}
```

## Security

- Never commit the real Bearer token or map password.
- Keep Node bound to localhost.
- Use HTTPS externally.
- `data/` and `.env` are ignored.
