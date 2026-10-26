// fww-crystal-patterns static server — zero-dependency Node HTTP server.
// Serves ./public on 127.0.0.1:PORT (fronted by the Cloudflare tunnel).
// Also serves /review/* — an internal, Basic-Auth-gated tool for naming
// pattern photos that only have a camera/export-generated filename.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8896;
const ROOT = path.join(__dirname, 'public');
const SYNC_ROOT = path.join(__dirname, 'sync_by_name');
const PENDING_FILE = path.join(__dirname, 'data', 'pending-renames.json');
const REVIEW_THUMB_DIR = path.join(__dirname, 'data', 'review-thumbs');
const REVIEW_AUTH_USER = process.env.REVIEW_AUTH_USER || '';
const REVIEW_AUTH_PASS = process.env.REVIEW_AUTH_PASS || '';

// Same width-folder slugs as sync.sh's MAP and build.js's manifest sections.
// DEPENDS: if sync.sh's MAP gains/renames a slug, update this list too.
const REVIEW_SECTIONS = [
  { slug: 'half', label: '1/2"' },
  { slug: 'five8', label: '5/8"' },
  { slug: 'one', label: '1"' },
  { slug: 'onehalf', label: '1.5"' },
  // Prong photos are amount-count reference shots, not patterns — kept in
  // the list (so /review/img/prong/* still resolves) but hidden from display.
  { slug: 'prong', label: 'Prong', hidden: true },
];
// DEPENDS: mirrors sync.sh's MAP and DRIVE_ID exactly — this is what lets
// /review/api/save rename the real Drive file, not just the local mirror.
const DRIVE_ID = '0AIEfu95vgNkWUk9PVA';
const DRIVE_FOLDER_BY_SLUG = {
  half: '1MiTFc1ui1A08hc8lUlYDC9eFoiiSyETx',
  five8: '1-3tQFRDHCi0rCc1UXns-NcC0SR5-wWa-',
  one: '1-4GmiSZKZUwXrg3kC1a1W2Htl1RmOEqB',
  onehalf: '1-58PetE9ZCpP6ljCNkvVZXbddlG9tVwg',
  prong: '1-8xvEIHMG5NkKnNL79AgPfxYGxdOtcIF',
};
function driveRename(slug, oldFilename, newName) {
  const folderId = DRIVE_FOLDER_BY_SLUG[slug];
  if (!folderId) return { ok: false, error: 'unknown slug' };
  try {
    cp.execFileSync('rclone', [
      'moveto', `gdrive_patterns:${oldFilename}`, `gdrive_patterns:${newName}`,
      '--drive-team-drive', DRIVE_ID, '--drive-root-folder-id', folderId,
    ], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e.stderr || e.message || String(e)).toString().slice(0, 500) };
  }
}
function triggerSync() {
  // Fire-and-forget so the HTTP response doesn't wait on a full sync run.
  // Best-effort logging to the same sync.log the hourly timer writes to —
  // must never throw, since a save's real work (the Drive rename) is
  // already done by the time this runs; a logging failure here must not
  // surface as if the save itself failed.
  let stdio = 'ignore';
  try {
    const log = fs.openSync(path.join(__dirname, 'sync.log'), 'a');
    stdio = ['ignore', log, log];
  } catch (_) { /* fall back to 'ignore' */ }
  try {
    const child = cp.spawn('bash', ['sync.sh'], { cwd: __dirname, detached: true, stdio });
    child.unref();
  } catch (_) { /* sync will still run on the next hourly timer */ }
  if (Array.isArray(stdio)) { try { fs.closeSync(stdio[1]); } catch (_) {} }
}
const UNNAMED_RE = /^(img|fwk|dsc|dscn|photo|screenshot)[_-]?\d+/i;
const HASH_RE = /^\d{6,}__[0-9a-f-]+$/i;
function isUnnamedFile(filename) {
  const base = filename.replace(/\.[a-zA-Z0-9]+$/, '');
  return UNNAMED_RE.test(base) || HASH_RE.test(base);
}
function hasCmd(c) {
  try { cp.execSync(`command -v ${c}`, { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}
const HAS_CONVERT = hasCmd('convert') || hasCmd('magick');
const CONVERT = hasCmd('magick') ? 'magick' : 'convert';
function ensureReviewThumb(slug, file) {
  const src = path.join(SYNC_ROOT, slug, file);
  const key = `${slug}__${file}`.replace(/[^a-zA-Z0-9._-]/g, '_');
  const dst = path.join(REVIEW_THUMB_DIR, `${key}.jpg`);
  if (fs.existsSync(dst) && fs.statSync(dst).size > 0) return dst;
  if (!HAS_CONVERT) return null;
  try {
    fs.mkdirSync(REVIEW_THUMB_DIR, { recursive: true });
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
  fs.mkdirSync(path.dirname(PENDING_FILE), { recursive: true });
  fs.writeFileSync(PENDING_FILE, JSON.stringify(data, null, 2));
}
function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function listUnnamedFiles(slug) {
  const dir = path.join(SYNC_ROOT, slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => !f.startsWith('.') && isUnnamedFile(f)).sort();
}
function listNamedFiles(slug) {
  const dir = path.join(SYNC_ROOT, slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => !f.startsWith('.') && !isUnnamedFile(f)).sort((a, b) => a.localeCompare(b));
}
function displayName(f) {
  return f.replace(/\.(jpe?g|png|gif|webp|heic|heif|pdf)$/i, '');
}
function renderCard(slug, f, pending, opts) {
  const key = `${slug}/${f}`;
  const entry = pending[key];
  const skipped = !!(entry && entry.skip);
  const val = entry ? (entry.skip ? '' : entry.name) : (opts.prefillCurrentName ? displayName(f) : '');
  const ext = path.extname(f).toLowerCase();
  const imgSrc = '/review/img/' + encodeURIComponent(slug) + '/' + encodeURIComponent(f);
  // This VPS's ImageMagick build has no HEIC codec, so there's no preview
  // to generate — link to the original instead of a broken <img>.
  // Card thumbnail is deliberately small (grid density); many of these
  // photos have the pattern name handwritten on them, so link to the full
  // original in a new tab where normal browser zoom works.
  // HEIC has no browser-native preview either way, so that one stays a
  // plain link (opens/downloads via the browser's own handler); everything
  // else opens in the in-page lightbox modal instead of a new tab.
  const media = (ext === '.heic' || ext === '.heif')
    ? `<a class="thumb-fallback" href="${imgSrc}" target="_blank" rel="noopener">HEIC — open original</a>`
    : `<img loading="lazy" src="${imgSrc}" alt="${escHtml(f)}" class="thumb-click" data-full="${imgSrc}">`;
  const skipRow = opts.showSkip
    ? `<label class="skip-row"><input type="checkbox" class="skip-box" ${skipped ? 'checked' : ''}> not a pattern / skip</label>`
    : '';
  return `
      <div class="card${opts.needsAttention ? ' needs-attention' : ''}" data-key="${escHtml(key)}">
        ${media}
        <div class="meta">
          <div class="fname">${escHtml(f)}</div>
          <input type="text" class="name-input" placeholder="Pattern name..." value="${escHtml(val)}" data-orig="${escHtml(val)}" ${skipped ? 'disabled' : ''}>
          ${skipRow}
          <span class="status"></span>
        </div>
      </div>`;
}
function renderReviewPage() {
  const pending = loadPending();
  let stillPending = 0; // unnamed files in VISIBLE sections with no name saved yet
  // One section per width, unnamed cards first (still need action) then
  // named ones (editable) — so finding e.g. 1.5" doesn't mean scrolling
  // past every other width's named block first.
  const sectionsHtml = REVIEW_SECTIONS.map(sec => {
    const unnamed = listUnnamedFiles(sec.slug);
    const named = listNamedFiles(sec.slug);
    if (!sec.hidden) {
      unnamed.forEach(f => {
        const entry = pending[`${sec.slug}/${f}`];
        if (!entry || (!entry.name && !entry.skip)) stillPending++;
      });
    }
    if (sec.hidden) return '';
    if (unnamed.length === 0 && named.length === 0) return '';
    const unnamedCards = unnamed.map(f => renderCard(sec.slug, f, pending, { showSkip: true, prefillCurrentName: false, needsAttention: true })).join('\n');
    const namedCards = named.map(f => renderCard(sec.slug, f, pending, { showSkip: false, prefillCurrentName: true })).join('\n');
    const countLabel = unnamed.length
      ? `<span class="count">${unnamed.length} unnamed</span> · ${named.length} named`
      : `${named.length} named`;
    // Collapsible per width — expanded by default only when something in
    // it still needs a name, so opening the page doesn't mean scrolling
    // through 128 already-named 1.5" cards to find the one width that
    // actually needs attention.
    const open = unnamed.length ? ' open' : '';
    return `<details class="section"${open}><summary><h2>${escHtml(sec.label)} ${countLabel}</h2></summary><div class="grid">${unnamedCards}${namedCards}</div></details>`;
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
  section, .section { padding: 8px 24px 28px; }
  .section summary { list-style:none; cursor:pointer; }
  .section summary::-webkit-details-marker { display:none; }
  .section summary h2::before { content:"▸ "; display:inline-block; color:var(--accent); transition:transform .15s; }
  .section[open] summary h2::before { content:"▾ "; }
  .section summary:hover h2 { color:var(--ink); }
  h2 { font-size:15px; text-transform:uppercase; letter-spacing:.06em; color:#77706a; border-bottom:1px solid var(--line); padding-bottom:8px; margin:0; }
  h2 .count { color:var(--accent); font-weight:600; }
  .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap:16px; margin-top:14px; }
  .card { background:#fff; border:1px solid var(--line); border-radius:8px; overflow:hidden; display:flex; flex-direction:column; }
  .card.needs-attention { border:2px solid var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
  .card img { width:100%; height:180px; object-fit:cover; background:#eee; display:block; cursor:zoom-in; }
  .thumb-fallback { display:flex; align-items:center; justify-content:center; width:100%; height:180px; background:#f2f0ec; color:var(--accent); font-size:13px; text-decoration:underline; }
  .meta { padding:10px; display:flex; flex-direction:column; gap:6px; }
  .fname { font-size:11px; color:#9a938c; word-break:break-all; }
  .name-input { font-size:14px; padding:6px 8px; border:1px solid var(--line); border-radius:5px; }
  .name-input:disabled { background:#f2f0ec; color:#aaa; }
  .skip-row { font-size:12px; color:#77706a; display:flex; align-items:center; gap:5px; }
  .status { font-size:11px; min-height:14px; line-height:1.4; color:var(--ok); }
  .divider { margin:36px 24px 0; padding-top:20px; border-top:3px solid var(--line); }
  .divider h1 { font-size:16px; text-transform:uppercase; letter-spacing:.06em; color:#77706a; margin:0 0 4px; }
  .divider p { margin:0; font-size:13px; color:#9a938c; }
  #lightbox { position:fixed; inset:0; background:rgba(20,17,14,.92); display:none; align-items:center; justify-content:center; z-index:50; padding:16px; }
  #lightbox.open { display:flex; }
  #lightbox img { max-width:100%; max-height:100%; object-fit:contain; touch-action:pinch-zoom; }
  #lightbox-close { position:fixed; top:14px; right:18px; color:#fff; font-size:32px; line-height:1; background:none; border:none; cursor:pointer; z-index:51; padding:6px 10px; }
  @media (max-width:600px) {
    .grid { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:10px; }
    .card img { height:130px; }
  }
</style></head>
<body>
<header>
  <h1>Crystal Patterns — name the unnamed</h1>
  <p>${stillPending > 0 ? `${stillPending} still need a name — outlined cards below.` : 'Everything is named ✓'} Type a name and click away (or hit Enter) — renames the real file in Drive immediately.</p>
</header>
${sectionsHtml || '<section><p style="padding:24px">Nothing here — nice.</p></section>'}
<div id="lightbox"><button id="lightbox-close" aria-label="Close">&times;</button><img id="lightbox-img" src="" alt=""></div>
<script>
document.querySelectorAll('.card').forEach(card => {
  const key = card.dataset.key;
  const input = card.querySelector('.name-input');
  const skip = card.querySelector('.skip-box');
  const status = card.querySelector('.status');
  async function save() {
    status.textContent = 'renaming in Drive...';
    status.style.color = '';
    try {
      const res = await fetch('/review/api/save', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ key, name: input.value.trim(), skip: skip ? skip.checked : false })
      });
      if (!res.ok) throw new Error(await res.text());
      const body = await res.json();
      if (skip) input.disabled = skip.checked;
      input.dataset.orig = input.value.trim();
      if ((skip && skip.checked) || !body.drive || body.drive.ok) {
        status.textContent = (skip && skip.checked) ? 'marked skipped' : 'renamed in Drive ✓';
        setTimeout(() => { status.textContent=''; }, 2000);
      } else {
        status.textContent = 'saved, but Drive rename FAILED — ' + (body.drive.error || 'unknown error').slice(0, 80);
        status.style.color = '#b3261e';
      }
    } catch (e) { status.textContent = 'ERROR — retry'; status.style.color = '#b3261e'; }
  }
  // Only save if the value actually changed — with ~180 pre-filled "already
  // named" fields, tabbing/clicking through unmodified ones must not fire a
  // rename+sync every time.
  input.addEventListener('blur', () => { if (input.value.trim() && input.value.trim() !== input.dataset.orig) save(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); input.blur(); } });
  if (skip) skip.addEventListener('change', save);
});
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightbox-img');
document.querySelectorAll('.thumb-click').forEach(img => {
  img.addEventListener('click', () => {
    lightboxImg.src = img.dataset.full;
    lightboxImg.alt = img.alt;
    lightbox.classList.add('open');
  });
});
function closeLightbox() { lightbox.classList.remove('open'); lightboxImg.src = ''; }
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);
lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });
</script>
</body></html>`;
}
function checkReviewAuth(req) {
  if (!REVIEW_AUTH_USER) return true; // no credential configured -> auth disabled
  const hdr = req.headers['authorization'] || '';
  const m = /^Basic (.+)$/.exec(hdr);
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const idx = decoded.indexOf(':');
  return decoded.slice(0, idx) === REVIEW_AUTH_USER && decoded.slice(idx + 1) === REVIEW_AUTH_PASS;
}
function handleReview(req, res, urlPath) {
  if (!checkReviewAuth(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Crystal Patterns Review"' });
    res.end('Auth required');
    return;
  }
  if (urlPath === '/review' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderReviewPage());
    return;
  }
  if (urlPath.startsWith('/review/img/') && req.method === 'GET') {
    const parts = urlPath.slice('/review/img/'.length).split('/').map(decodeURIComponent);
    if (parts.length !== 2) { res.writeHead(400); res.end('bad path'); return; }
    const [slug, file] = parts;
    if (!REVIEW_SECTIONS.some(s => s.slug === slug) || file.includes('..')) { res.writeHead(400); res.end('bad path'); return; }
    const ext = path.extname(file).toLowerCase();
    let servePath = path.join(SYNC_ROOT, slug, file);
    let contentType = 'image/jpeg';
    if (ext === '.heic' || ext === '.heif') {
      // No libheif on this box, so no thumbnail — serve the original bytes
      // with the right Content-Type; HEIC-capable clients (e.g. Safari/iOS)
      // can still render it, others get a correctly-typed download.
      const thumb = ensureReviewThumb(slug, file);
      if (thumb) { servePath = thumb; } else { contentType = ext === '.heic' ? 'image/heic' : 'image/heif'; }
    } else if (ext === '.png') contentType = 'image/png';
    if (!fs.existsSync(servePath)) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    fs.createReadStream(servePath).pipe(res);
    return;
  }
  if (urlPath === '/review/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      try {
        const { key, name, skip } = JSON.parse(body);
        if (typeof key !== 'string' || !key.includes('/')) throw new Error('bad key');
        const pending = loadPending();
        const [slug, file] = key.split('/');
        const cleanName = String(name || '').slice(0, 200);
        const prev = pending[key] || {};
        const entry = { name: cleanName, skip: !!skip, updatedAt: new Date().toISOString(), driveName: prev.driveName };

        let driveResult = null;
        if (!skip && cleanName) {
          // Rename FROM whatever the file is currently called in Drive —
          // either the original camera filename, or a prior successful
          // rename by this same tool (so correcting a typo re-renames
          // from the corrected name, not a now-stale original one).
          const sourceName = prev.driveName || file;
          if (sourceName !== cleanName) {
            driveResult = driveRename(slug, sourceName, cleanName);
            if (driveResult.ok) entry.driveName = cleanName;
          } else {
            driveResult = { ok: true, noop: true };
          }
        }

        pending[key] = entry;
        savePending(pending);
        if (driveResult && driveResult.ok) triggerSync();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, drive: driveResult }));
      } catch (e) { res.writeHead(400); res.end('bad request'); }
    });
    return;
  }
  res.writeHead(404); res.end('not found');
}

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
  let urlPath = req.url.split('?')[0];
  // /review/* needs POST for saving names, so it's dispatched before the
  // GET/HEAD-only gate that guards the static gallery below.
  if (urlPath === '/review' || urlPath.startsWith('/review/')) {
    handleReview(req, res, urlPath);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405); res.end('Method Not Allowed'); return;
  }
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
