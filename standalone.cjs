// Standalone entry point. When FindMe runs inside main-server, that process
// requires ./server.cjs directly and this file is unused.
//
// The app itself is mount-relative, so it is mounted here under the same public
// prefix main-server uses. That keeps generated links identical in both modes
// and lets the reverse proxy forward /findme/ through without rewriting.
const express = require('express');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.PORT || 3210);
const BASE_PATH = process.env.FINDME_BASE_PATH || '/findme';

let findmeApp;
try {
  findmeApp = require('./server.cjs');
} catch (error) {
  console.error(`FindMe failed to start: ${error.message}`);
  process.exit(1);
}

const server = express();
server.disable('x-powered-by');
server.use(BASE_PATH, findmeApp);

server.listen(PORT, '127.0.0.1', () => {
  console.log(`FindMe listening at http://127.0.0.1:${PORT}${BASE_PATH}/`);
});
