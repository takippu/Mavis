'use strict';

// Loopback static server for the brain-viz build (viz/dist). The webview can't load
// the stock Vite dist over file:// — ES modules are CORS-blocked (origin null) and the
// absolute /assets paths resolve to the filesystem root. Serving it over http://127.0.0.1
// makes modules + absolute paths + cytoscape load normally. Reads from disk each request,
// so a rebuild is picked up without restarting the server.
//
// viz/dist/data.json is a full export of the PRIVATE brain, so the server is hardened:
//   (1) Host-header must be the exact loopback host:port we bound — defeats DNS-rebinding
//       reads from an ordinary browser (a rebound page sends its own hostname as Host).
//   (2) a per-launch random token is required on every request — bootstrapped via ?k= on
//       the webview's index URL, then carried automatically by a same-site cookie. Other
//       local processes can't read the export without the secret.
// Bound to 127.0.0.1 only, read-only GET/HEAD, path-traversal-guarded to viz/dist.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain; charset=utf-8',
};

let server = null;
let baseUrl = null;
let host = null; // '127.0.0.1:<port>'
let token = null;
let startPromise = null;

function cookieToken(req) {
  const m = /(?:^|;\s*)mvz=([^;]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
}

function queryToken(url) {
  const q = String(url || '').split('?')[1];
  if (!q) return null;
  const m = /(?:^|&)k=([^&]+)/.exec(q);
  try { return m ? decodeURIComponent(m[1]) : null; } catch { return null; }
}

function handler(distRoot) {
  return (req, res) => {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }
      // (1) Host must be exactly the loopback host:port we bound — kills DNS-rebinding.
      if (String(req.headers.host || '').toLowerCase() !== host) { res.writeHead(403); return res.end('forbidden'); }
      // (2) per-launch token via ?k= (bootstrap) or the mvz cookie (subsequent requests).
      if (queryToken(req.url) !== token && cookieToken(req) !== token) { res.writeHead(403); return res.end('forbidden'); }

      let urlPath = decodeURIComponent(String(req.url || '/').split('?')[0].split('#')[0]);
      if (!urlPath || urlPath === '/') urlPath = '/index.html';
      // strip leading slashes so path.join treats it as relative to distRoot
      const rel = urlPath.replace(/^[/\\]+/, '');
      const abs = path.normalize(path.join(distRoot, rel));
      // traversal guard: resolved path must stay inside distRoot
      const within = abs === distRoot || abs.toLowerCase().startsWith((distRoot + path.sep).toLowerCase());
      if (!within) { res.writeHead(403); return res.end('forbidden'); }
      fs.readFile(abs, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        const type = MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';
        res.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': 'no-store',
          'Set-Cookie': 'mvz=' + token + '; Path=/; SameSite=Strict; HttpOnly',
        });
        res.end(req.method === 'HEAD' ? undefined : buf);
      });
    } catch {
      res.writeHead(500); res.end('error');
    }
  };
}

// Start (idempotent) the loopback server for vizRoot/dist. Resolves to the base URL
// (e.g. http://127.0.0.1:53124/), or null if it can't bind.
function startVizServer(vizRoot) {
  if (baseUrl) return Promise.resolve(baseUrl);
  if (startPromise) return startPromise;
  const distRoot = path.normalize(path.join(vizRoot, 'dist'));
  startPromise = new Promise((resolve) => {
    token = crypto.randomBytes(18).toString('hex');
    const s = http.createServer(handler(distRoot));
    s.on('error', () => {
      // pre-listen bind failure leaves server null; a post-listen error must tear down
      // the now-stale server/baseUrl so the next start rebinds instead of handing back a
      // dead URL. resolve(null) is a no-op once the promise already settled with baseUrl.
      if (server === s) { try { s.close(); } catch { /* noop */ } server = null; baseUrl = null; host = null; }
      startPromise = null;
      resolve(null);
    });
    s.listen(0, '127.0.0.1', () => {
      server = s;
      const addr = s.address();
      host = '127.0.0.1:' + addr.port;
      baseUrl = 'http://' + host + '/';
      resolve(baseUrl);
    });
  });
  return startPromise;
}

function getBaseUrl() { return baseUrl; }
// Tokenized index URL the webview navigates to (carries the bootstrap ?k=).
function getIndexUrl() { return baseUrl ? baseUrl + 'index.html?k=' + token : null; }

function stopVizServer() {
  if (server) { try { server.close(); } catch { /* noop */ } }
  server = null; baseUrl = null; host = null; token = null; startPromise = null;
}

module.exports = { startVizServer, getBaseUrl, getIndexUrl, stopVizServer };
