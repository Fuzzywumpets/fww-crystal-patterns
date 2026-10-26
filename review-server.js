// review-server.js — quick internal tool: lists pattern photos that only
// have a camera/export-generated filename (IMG_1234.jpg, FWK_0398.jpg, a
// Shopify-style hash id) instead of a real pattern name, grouped by width,
// with a text box next to each so Alex can supply the real name.
//
// Submissions are stored in data/pending-renames.json — NOT applied to the
// source Drive files. Claude reads that file and does the actual Drive
// rename separately (the sync service account is read-only).
//
// DEPENDS: sync.sh / build.js's UNNAMED-file detection regex below must
// stay in sync with what actually shows up as camera/export garbage in the
// "2026 Crystal Patterns" Drive — if the naming convention there changes,
// update UNNAMED_RE/HASH_RE to match.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = __dirname;
const SYNC_ROOT = path.join(ROOT, 'sync_by_name');
const DATA_DIR = path.join(ROOT, 'data');
const PENDING_FILE = path.join(DATA_DIR, 'pending-renames.json');
const THUMB_DIR = path.join(DATA_DIR, 'thumbs');
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8898;

const AUTH_USER = process.env.REVIEW_AUTH_USER || '';
const AUTH_PASS = process.env.REVIEW_AUTH_PASS || '';

const SECTIONS = [
  { slug: 'half', label: '1/2"' },
  { slug: 'five8', label: '5/8"' },
  { slug: 'one', label: '1"' },
  { slug: 'onehalf', label: '1.5"' },
  { slug: 'prong', label: 'Prong' },
];

const UNNAMED_RE = /^(img|fwk|dsc|dscn|photo|screenshot)[_-]?\d+/i;
const HASH_RE = /^\d{6,}__[0-9a-f-]+$/i;
function isUnnamed(filename) {
  const base = filename.replace(/\.[a-zA-Z0-9]+$/, '');
  return UNNAMED_RE.test(base) || HASH_RE.test(base);
}

function hasCmd(c) {
  try { cp.execSync(`command -v ${c}`, { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}
const HAS_CONVERT = hasCmd('convert') || hasCmd('magick');
const CONVERT = hasCmd('magick') ? 'magick' : 'convert';

function ensureThumb(slug, file) {
  const src = path.join(SYNC_ROOT, slug, file);
  const key = `${slug}__${file}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dst = path.join(THUMB_DIR, `${key}.jpg`);
  if (fs.existsSync(dst) && fs.statSync(dst).size > 0) return dst;
  if (!HAS_CONVERT) return null;
  try {
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    cp.execFileSync(CONVERT, [`${src}[0]`, '-auto-orient', '-strip', '-resize', '900x900>', '-quality', '85', dst],
      { stdio: 'ignore', timeout: 60000 });
    if (fs.existsSync(dst) && fs.statSync(dst).size > 0) return dst;
  } catch (_) { /* fall through */ }
  return null;
}

function loadPending() {
  try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch (_) { return {}; }
}
function savePending(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2));
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function listUnnamed(slug) {
  const dir = path.join(SYNC_ROOT, slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => !f.startsWith('.') && isUnnamed(f)).sort();
}

function renderPage() {
  const pending = loadPending();
  let totalUnnamed = 0, totalDone = 0;
  const sectionsHtml = SECTIONS.map(sec => {
    const files = listUnnamed(sec.slug);
    if (files.length === 0) return '';
    const cards = files.map(f => {
      const key = `${sec.slug}/${f}`;
      const entry = pending[key];
      const val = entry && !entry.skip ? entry.name : '';
      const skipped = entry && entry.skip;
      totalUnnamed++;
      if (entry && (entry.name || entry.skip)) totalDone++;
      return `
      <div class="card" data-key="${esc(key)}">
        <img loading="lazy" src="/img/${encodeURIComponent(sec.slug)}/${encodeURIComponent(f)}" alt="${esc(f)}">
        <div class="meta">
          <div class="fname">${esc(f)}</div>
          <input type="text" class="name-input" placeholder="Pattern name..." value="${esc(val)}" ${skipped ? 'disabled' : ''}>
          <label class="skip-row"><input type="checkbox" class="skip-box" ${skipped ? 'checked' : ''}> not a pattern / skip</label>
          <span class="status"></span>
        </div>
      </div>`;
    }).join('\n');
    return `<section><h2>${esc(sec.label)} <span class="count">${files.length}</span></h2><div class="grid">${cards}</div></section>`;
  }).join('\n');

  return `<!doctype html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Crystal Patterns — name the unnamed</title>
<style>
  :root { --bg:#faf9f7; --ink:#1c1a17; --line:#e3ddd3; --accent:#7a5a3a; --ok:#2f7d4f; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, Segoe UI, sans-serif; background:var(--bg); color:var(--ink); }
  header { padding:18px 24px; border-bottom:1px solid var(--line); background:#fff; position:sticky; top:0; z-index:5; }
  header h1 { font-size:18px; margin:0 0 4px; }
  header p { margin:0; font-size:13px; color:#77706a; }
  section { padding: 8px 24px 28px; }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.06em; color:#77706a; border-bottom:1px solid var(--line); padding-bottom:8px; }
  h2 .count { color:var(--accent); font-weight:600; }
  .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:16px; margin-top:14px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:8px; overflow:hidden; display:flex; flex-direction:column; }
  .card img { width:100%; height:180px; object-fit:cover; background:#eee; display:block; }
  .meta { padding:10px; display:flex; flex-direction:column; gap:6px; }
  .fname { font-size:11px; color:#9a938c; word-break:break-all; }
  .name-input { font-size:14px; padding:6px 8px; border:1px solid var(--line); border-radius:5px; }
  .name-input:disabled { background:#f2f0ec; color:#aaa; }
  .skip-row { font-size:12px; color:#77706a; display:flex; align-items:center; gap:5px; }
  .status { font-size:11px; height:14px; color:var(--ok); }
</style></head>
<body>
<header>
  <h1>Crystal Patterns — name the unnamed</h1>
  <p>${totalDone} / ${totalUnnamed} filled in. Type a name and click away (or hit Enter) to save — saves are queued for review, not applied to Drive yet.</p>
</header>
${sectionsHtml || '<section><p style="padding:24px">Nothing unnamed right now — nice.</p></section>'}
<script>
document.querySelectorAll('.card').forEach(card => {
  const key = card.dataset.key;
  const input = card.querySelector('.name-input');
  const skip = card.querySelector('.skip-box');
  const status = card.querySelector('.status');
  async function save() {
    status.textContent = 'saving...';
    try {
      const res = await fetch('/api/save', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ key, name: input.value.trim(), skip: skip.checked })
      });
      if (!res.ok) throw new Error(await res.text());
      status.textContent = 'saved';
      input.disabled = skip.checked;
      setTimeout(() => { status.textContent=''; }, 1500);
    } catch (e) { status.textContent = 'ERROR — retry'; status.style.color = '#b3261e'; }
  }
  input.addEventListener('blur', () => { if (input.value.trim()) save(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  skip.addEventListener('change', save);
});
</script>
</body></html>`;
}

function checkAuth(req) {
  if (!AUTH_USER) return true; // no credential configured -> auth disabled
  const hdr = req.headers['authorization'] || '';
  const m = /^Basic (.+)$/.exec(hdr);
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  const user = decoded.slice(0, idx), pass = decoded.slice(idx + 1);
  return user === AUTH_USER && pass === AUTH_PASS;
}

const server = http.createServer((req, res) => {
  if (!checkAuth(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Crystal Patterns Review"' });
    res.end('Auth required');
    return;
  }
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/health') { res.writeHead(200); res.end('ok'); return; }

  if (urlPath === '/' && req.method === 'GET') {
    const html = renderPage();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  if (urlPath.startsWith('/img/') && req.method === 'GET') {
    const parts = urlPath.slice('/img/'.length).split('/').map(decodeURIComponent);
    if (parts.length !== 2) { res.writeHead(400); res.end('bad path'); return; }
    const [slug, file] = parts;
    if (!SECTIONS.some(s => s.slug === slug) || file.includes('..')) { res.writeHead(400); res.end('bad path'); return; }
    const ext = path.extname(file).toLowerCase();
    let servePath = path.join(SYNC_ROOT, slug, file);
    let contentType = 'image/jpeg';
    if (ext === '.heic' || ext === '.heif') {
      // Browsers can't render HEIC/HEIF inline — serve a JPEG preview instead.
      const thumb = ensureThumb(slug, file);
      if (thumb) { servePath = thumb; } else { res.writeHead(415); res.end('HEIC preview unavailable'); return; }
    } else if (ext === '.png') contentType = 'image/png';
    if (!fs.existsSync(servePath)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    fs.createReadStream(servePath).pipe(res);
    return;
  }

  if (urlPath === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const { key, name, skip } = JSON.parse(body);
        if (typeof key !== 'string' || !key.includes('/')) throw new Error('bad key');
        const pending = loadPending();
        pending[key] = { name: String(name || '').slice(0, 200), skip: !!skip, updatedAt: new Date().toISOString() };
        savePending(pending);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.writeHead(400); res.end('bad request');
      }
    });
    return;
  }

  res.writeHead(404); res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`review-server listening on 127.0.0.1:${PORT}`);
});
