# Agent notes for findme

FindMe is an **Express sub-app mounted at `/findme`** by `../main/main-server.js`.
It is not a standalone server. Several things below look like bugs or unfinished
code if you only read this directory — they are deliberate, and "fixing" them
breaks routing on the production site.

`server.cjs` exports a mount-relative app. `standalone.cjs` is the only entry
point that listens on a port.

## Do not change these

**`server.cjs` must end with `module.exports = app`, and must never call
`app.listen()`.** `main-server.js` does `require('../findme/server.cjs')` and
mounts the result. A `server.cjs` without the export makes `require()` return
`{}`, and the mount fails with `Router.use() requires a middleware function but
got a Object`. This has already caused one outage.

**Routes stay mount-relative.** They are declared as `'/'`,
`'/screenshots/:name'`, and `'/api/locations'`. The `/findme` prefix comes from
the mount. Re-adding it produces `/findme/findme/`.

**The public prefix is derived, never hardcoded.** `mountBase(req)` returns
`req.baseUrl`, which feeds `screenshotUrl()` and the map page's
`fetch('${base}/api/locations')`. That `${base}` is inside a server-side
template literal, so it is interpolated before the HTML is sent — it only looks
like client-side code. Hardcoding `/findme` breaks standalone mode; dropping it
breaks mounted mode.

**dotenv must keep the `__dirname` path:**
`require('dotenv').config({ path: path.join(__dirname, '.env') })`. A bare
`.config()` resolves against the working directory, which is `main/` when
main-server loads this app, so the credentials silently fail to load.

**Missing env vars must `throw`, not `process.exit(1)`.** An exit would kill the
whole main-server process and every other mounted app with it. The throw is
caught by the mount's try/catch, which serves a 503 for `/findme` only.

**`locations.jsonl` stores a bare screenshot filename**, not a path or URL. The
URL is rebuilt per request by `screenshotUrl()` so it matches whatever prefix
the app is mounted under.

**FindMe parses its own request bodies** (`parseIncoming`), because it accepts
multipart uploads and Base64 screenshots up to 12 MB. This is paired with an
exemption in main-server — see below.

## Related code in ../main/main-server.js

Do not modify these without understanding the coupling:

- The `/findme` exemption from the global body parsers (`SELF_PARSED_PREFIXES`,
  `parsesOwnBody`, and the two wrapped `app.use(...)` calls). `express.json()`
  defaults to a 100 KB limit, so collapsing these back to plain
  `app.use(express.json())` makes every screenshot upload fail with a 413.
- The `// Mount FindMe under /findme` block, including the
  `typeof findmeApp !== 'function'` guard that reports a stale `server.cjs`
  with a clear message.
- The `{ name: 'FindMe', prefix: '/findme', ... }` row in
  `getAppadminAppsSnapshot`, which reads the `findmeApp` variable.
- Mount ordering: the `/findme` mount must stay after the body-parser
  middleware and before the catch-all `app.use('*', ...)` 404 handler.

## Operational

- `npm start` runs `standalone.cjs`, not `server.cjs`.
- `.env` and `data/` are gitignored and hold real credentials and user location
  history. Never commit them or print their contents.
- `core.fileMode` is set to `false` locally. The CIFS mount forces `0755` on
  every file, so leaving it unset makes the whole tree look modified.
- Do not run standalone findme and the main-server mount at the same time; both
  write to the same `data/` directory.
- Do not restart or kill the production main-server as a side effect of testing.

## Verifying a change

Mount the app the way main-server does rather than testing it standalone:

```js
const app = express();                       // express 4, as in main-server
app.use('/findme', require('./server.cjs')); // must be a function
```

Then check that `GET /findme/` returns the map with
`fetch('/findme/api/locations')` in it, that a `POST /findme/` with a Bearer
token is accepted, and that screenshot URLs come back prefixed with
`/findme/screenshots/`.
