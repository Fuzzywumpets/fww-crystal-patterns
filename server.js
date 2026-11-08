// fww-crystal-patterns static server — zero-dependency Node HTTP server.
// Serves ./public on 127.0.0.1:PORT (fronted by the Cloudflare tunnel).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8896;
const ROOT = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function safeJoin(root, reqPath) {
  const decoded = decodeURIComponent(reqPath.split('?')[0]);
  const p = path.normalize(path.join(root, decoded));
  if (!p.startsWith(root)) return null; // path traversal guard
  return p;
}

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }
  let urlPath = req.url.split('?')[0];
  if (urlPath === '/' || urlPath === '') urlPath = '/index.html';
  if (urlPath === '/health' || urlPath === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return;
  }
  let filePath = safeJoin(ROOT, urlPath);
  if (!filePath) { res.writeHead(400); res.end('Bad Request'); return; }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      if (!err && st && st.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
      } else {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h1>404</h1><p>Not found.</p>');
        return;
      }
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const headers = { 'Content-Type': type };
    // PDFs open inline in-browser; images cached a day; html revalidates.
    if (ext === '.pdf') headers['Content-Disposition'] = 'inline';
    if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.heif', '.pdf'].includes(ext)) {
      headers['Cache-Control'] = 'public, max-age=86400';
    } else {
      headers['Cache-Control'] = 'no-cache';
    }
    fs.stat(filePath, (e2, st2) => {
      if (e2 || !st2.isFile()) { res.writeHead(404); res.end('Not found'); return; }
      headers['Content-Length'] = st2.size;
      if (req.method === 'HEAD') { res.writeHead(200, headers); res.end(); return; }
      res.writeHead(200, headers);
      fs.createReadStream(filePath).on('error', () => { try { res.end(); } catch (_) {} }).pipe(res);
    });
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`fww-crystal-patterns serving ${ROOT} on http://127.0.0.1:${PORT}`);
});
