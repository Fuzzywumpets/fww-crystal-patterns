// build.js — regenerate public/index.html from data/manifest.json + files on disk.
// Only includes files that actually exist under public/patterns/<slug>/<id>.<ext>.
// Generates a thumbnail (max 600px) per raster image into public/thumbs when possible.
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const ROOT = __dirname;
const PUB = path.join(ROOT, 'public');
const PATTERNS = path.join(PUB, 'patterns');
const THUMBS = path.join(PUB, 'thumbs');
const MANIFEST = path.join(ROOT, 'data', 'manifest.json');

const EXT_BY_MIME = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'image/heif': 'jpg', 'image/heic': 'jpg',
  'application/pdf': 'pdf',
};

function hasCmd(c) {
  try { cp.execSync(`command -v ${c}`, { stdio: 'ignore' }); return true; }
  catch (_) { return false; }
}
const HAS_CONVERT = hasCmd('convert') || hasCmd('magick');
const CONVERT = hasCmd('magick') ? 'magick' : 'convert';

// DEPENDS: sync.sh (rclone --exclude filter, not --include-by-extension) —
// this drive has real photos with no extension in the filename (e.g.
// "1.5\" Dynasty"), confirmed 2026-08-07. Sniff the real type so they still
// get a thumbnail and a correct Content-Type from server.js's ext-keyed map.
const KNOWN_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'pdf']);
// EXT_BY_MIME maps heic/heif -> jpg, which is only correct where the caller
// actually converts the bytes (the pre-existing "manifest" clone path did).
// detectExt here only renames, it never re-encodes — so heic/heif must keep
// their real extension or the served Content-Type would lie about the bytes.
const EXT_BY_MIME_NAMES = { ...EXT_BY_MIME, 'image/heif': 'heif', 'image/heic': 'heic' };
function detectExt(absPath) {
  // execFileSync (not execSync) — filenames legitimately contain literal
  // '"' inch marks (e.g. Aqua clover hearts 1.5"), which breaks shell quoting.
  try {
    const mime = cp.execFileSync('file', ['--mime-type', '-b', absPath], { encoding: 'utf8' }).trim();
    if (EXT_BY_MIME_NAMES[mime]) return EXT_BY_MIME_NAMES[mime];
  } catch (_) { /* fall through to default */ }
  return 'jpg'; // every extensionless file seen in this drive so far is a photo
}

function ensureThumb(srcAbs, id, ext) {
  // Return web path to a thumbnail if we can make/have one, else null.
  const isRaster = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext);
  if (!isRaster || !HAS_CONVERT) return null;
  const dst = path.join(THUMBS, `${id}.jpg`);
  const web = `/thumbs/${id}.jpg`;
  try {
    if (fs.existsSync(dst) && fs.statSync(dst).size > 0) return web;
    // execFileSync (not execSync) — filenames legitimately contain literal
    // '"' inch marks, which breaks shell quoting in a template-string command.
    // -auto-orient fixes phone EXIF rotation; strip metadata; cap 600px; quality 80
    cp.execFileSync(CONVERT, [`${srcAbs}[0]`, '-auto-orient', '-strip', '-resize', '600x600>', '-quality', '80', dst],
      { stdio: 'ignore', timeout: 60000 });
    if (fs.existsSync(dst) && fs.statSync(dst).size > 0) return web;
  } catch (_) { /* fall through to full image */ }
  return null;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function niceTitle(t) {
  // Drop file extension for display; keep human names as-is.
  return t.replace(/\.(jpe?g|png|gif|webp|heic|heif|pdf)$/i, '').trim();
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  fs.mkdirSync(THUMBS, { recursive: true });

  let totalShown = 0;
  const sectionsHtml = [];
  const navHtml = [];

  // SOURCE MODE:
  // - "names": rclone hourly sync populated sync_by_name/<slug>/ with real
  //   filenames. Index that directly (auto-picks up new/renamed files).
  // - "manifest": initial MCP clone wrote public/patterns/<slug>/<id>.<ext>.
  const NAMES_ROOT = path.join(ROOT, 'sync_by_name');
  function listNameEntries(slug) {
    const d = path.join(NAMES_ROOT, slug);
    if (!fs.existsSync(d)) return null;
    let names = [];
    try { names = fs.readdirSync(d).filter(n => !n.startsWith('.')); } catch (_) { return null; }
    if (names.length === 0) return null;
    return names.map(n => ({ file: n, dir: d }));
  }

  for (const sec of manifest.sections) {
    const cards = [];
    const nameEntries = listNameEntries(sec.slug);

    // Build a normalized work-list of {absPath, webPath, ext, title, key}.
    const work = [];
    if (nameEntries) {
      // Serve name-based files from a mounted static path /names/<slug>/<file>.
      // (server.js also serves public/; we copy/symlink names under public.)
      // Extensionless files get an extension appended below (e.g. "flower"
      // -> "flower.jpg"), which could collide with an unrelated real
      // "flower.jpg" already in the same folder — check against the actual
      // sibling filenames, not just against what's already staged on disk.
      const siblingNames = new Set(nameEntries.map(x => x.file));
      for (const e of nameEntries) {
        const abs = path.join(e.dir, e.file);
        let ext = path.extname(e.file).slice(1).toLowerCase();
        let stagedName = e.file;
        // path.extname("1.5” Dynasty") returns ".5” dynasty" — a bare dot in
        // a decimal-inch name, not a real extension — so check against a
        // known-extension whitelist, not mere non-emptiness.
        if (!KNOWN_EXTS.has(ext)) {
          ext = detectExt(abs);
          stagedName = `${e.file}.${ext}`;
          if (siblingNames.has(stagedName)) stagedName = `${e.file}__noext.${ext}`;
        }
        // stage into public/names/<slug>/ so the static server can serve it
        const stageDir = path.join(PUB, 'names', sec.slug);
        fs.mkdirSync(stageDir, { recursive: true });
        const staged = path.join(stageDir, stagedName);
        try { if (!fs.existsSync(staged)) fs.copyFileSync(abs, staged); } catch (_) {}
        work.push({
          abs: staged, web: '/names/' + sec.slug + '/' + encodeURIComponent(stagedName),
          ext, title: niceTitle(e.file), key: e.file.replace(/[^a-zA-Z0-9]/g, '_'),
        });
      }
    } else {
      for (const f of sec.files) {
        const ext = EXT_BY_MIME[f.mime] || 'jpg';
        const abs = path.join(PUB, `patterns/${sec.slug}/${f.id}.${ext}`);
        if (!fs.existsSync(abs) || fs.statSync(abs).size === 0) continue;
        work.push({
          abs, web: '/' + `patterns/${sec.slug}/${f.id}.${ext}`,
          ext, title: niceTitle(f.title), key: f.id,
        });
      }
    }

    for (const w of work) {
      const ext = w.ext === 'jpeg' ? 'jpg' : w.ext;
      const abs = w.abs;
      if (!fs.existsSync(abs) || fs.statSync(abs).size === 0) continue;
      const isPdf = ext === 'pdf';
      const title = w.title;
      const thumb = isPdf ? null : ensureThumb(abs, w.key, ext);
      const full = w.web;
      const thumbSrc = thumb || (isPdf ? null : full);
      const dt = esc(title.toLowerCase());
      const card = isPdf
        ? `<a class="card pdf" data-title="${dt}" href="${full}" target="_blank" rel="noopener">
             <div class="thumb pdf-thumb"><span class="pdf-badge">PDF</span></div>
             <div class="cap">${esc(title)}</div>
           </a>`
        : `<a class="card" data-title="${dt}" href="${full}" target="_blank" rel="noopener">
             <div class="thumb"><img loading="lazy" src="${thumbSrc}" alt="${esc(title)}"></div>
             <div class="cap">${esc(title)}</div>
           </a>`;
      cards.push(card);
      totalShown++;
    }
    if (cards.length === 0) continue;
    const anchor = 'sec-' + sec.slug;
    navHtml.push(`<a class="chip" href="#${anchor}">${esc(sec.name)} <span class="chip-n">${cards.length}</span></a>`);
    sectionsHtml.push(`
      <section id="${anchor}" class="section">
        <div class="section-head">
          <h2>${esc(sec.name)}</h2>
          <span class="count">${cards.length} pattern${cards.length === 1 ? '' : 's'}</span>
        </div>
        <div class="grid">${cards.join('\n')}</div>
      </section>`);
  }

  const updated = new Date().toLocaleString('en-US', {
    timeZone: 'America/Chicago', month: 'short', day: 'numeric',
    year: 'numeric', hour: 'numeric', minute: '2-digit',
  });

  // Cache-bust static assets (the logo got a stale 404 cached at the CF edge
  // during initial setup; a versioned URL is a fresh cache key).
  const assetV = Date.now().toString(36);
  const html = PAGE({
    nav: navHtml.join('\n'),
    sections: sectionsHtml.join('\n'),
    total: totalShown,
    updated,
    assetV,
  });
  fs.writeFileSync(path.join(PUB, 'index.html'), html);
  console.log(`build.js: wrote index.html with ${totalShown} files across ${navHtml.length} sections. thumbs=${HAS_CONVERT ? 'on' : 'off'}`);
}

function PAGE({ nav, sections, total, updated, assetV }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#000000">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-touch-fullscreen" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<title>Crystal Patterns — Fuzzywumpets</title>
<link rel="icon" href="/logo.png?v=${assetV}">
<link rel="apple-touch-icon" href="/logo.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,700;0,800;1,700;1,800&family=Saira+Extra+Condensed:wght@700;900&display=swap" rel="stylesheet">
<style>
  :root{
    --lime:#9BBC0E; --lime-soft:#b6d62a; --black:#000; --ink:#0c0c0c;
    --panel:#141414; --panel-2:#1c1c1c; --ivory:#fff; --muted:#9a9a9a;
    --line:rgba(255,255,255,.10); --radius:16px;
    --serif:"Playfair Display",Georgia,"Times New Roman",serif;
    --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --cond:"Saira Extra Condensed","alternate-gothic-extra-cond",Impact,sans-serif;
  }
  *{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    background:var(--black); color:var(--ivory); font-family:var(--sans);
    -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility;
    padding-bottom:64px;
  }
  a{color:inherit; text-decoration:none}

  /* Header */
  .top{
    position:sticky; top:0; z-index:20;
    background:linear-gradient(180deg,rgba(0,0,0,.96),rgba(0,0,0,.86));
    backdrop-filter:blur(10px);
    border-bottom:1px solid var(--line);
  }
  .top-inner{
    max-width:1400px; margin:0 auto; padding:16px 22px;
    display:flex; align-items:center; gap:18px;
  }
  .brand{display:flex; align-items:center; gap:16px; min-width:0}
  .brand img{height:52px; width:auto; display:block; filter:drop-shadow(0 2px 6px rgba(0,0,0,.6))}
  .brand-text{min-width:0}
  .kicker{
    font-family:var(--cond); font-size:17px; letter-spacing:.1em; text-transform:uppercase;
    color:var(--lime); font-weight:900; line-height:1;
  }
  .brand-text h1{
    font-family:var(--serif); font-weight:800; font-size:30px; line-height:1.05;
    margin:6px 0 0; color:var(--ivory);
  }
  .meta{margin-left:auto; text-align:right; color:var(--muted); font-size:12.5px; line-height:1.5; white-space:nowrap}
  .meta b{color:var(--lime); font-weight:800}

  /* Section nav (the width chips) */
  .nav{
    position:sticky; top:85px; z-index:15;
    background:rgba(0,0,0,.82); backdrop-filter:blur(8px);
    border-bottom:1px solid var(--line);
  }
  .nav-inner{
    max-width:1400px; margin:0 auto; padding:12px 22px;
    display:flex; flex-direction:column; gap:12px;
  }
  .chips{display:flex; gap:10px; flex-wrap:wrap}
  .search-wrap{position:relative; display:flex; align-items:center; max-width:520px; width:100%}
  #search{
    width:100%; box-sizing:border-box;
    padding:13px 42px 13px 44px; border-radius:999px;
    background:var(--panel) url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="%239a9a9a" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>') no-repeat 14px center;
    border:1px solid var(--line); color:var(--ivory);
    font-family:var(--sans); font-size:16px; font-weight:600; outline:none;
    transition:border-color .15s ease, box-shadow .15s ease;
  }
  #search::placeholder{color:var(--muted); font-weight:500}
  #search:focus{border-color:var(--lime); box-shadow:0 0 0 3px rgba(155,188,14,.22)}
  #search::-webkit-search-cancel-button{-webkit-appearance:none}
  #search-clear{
    position:absolute; right:8px; top:50%; transform:translateY(-50%);
    width:30px; height:30px; border-radius:50%; border:none; cursor:pointer;
    background:var(--panel-2); color:var(--muted); font-size:20px; line-height:1;
    display:flex; align-items:center; justify-content:center; padding:0;
  }
  #search-clear:hover{color:var(--ivory); background:#2a2a2a}
  .noresults{color:var(--muted); font-size:15px; padding:4px 2px}
  .noresults span{color:var(--ivory); font-weight:700}
  .chip{
    display:inline-flex; align-items:center; gap:8px;
    padding:11px 18px; border-radius:999px;
    background:var(--panel); border:1px solid var(--line);
    font-weight:700; font-size:15px; color:var(--ivory);
    transition:transform .08s ease, background .15s ease, border-color .15s ease;
    -webkit-tap-highlight-color:transparent;
  }
  .chip:hover,.chip:focus{background:var(--panel-2); border-color:var(--lime)}
  .chip:active{transform:scale(.97)}
  .chip-n{
    font-size:12.5px; font-weight:800; color:var(--black);
    background:var(--lime); border-radius:999px; padding:2px 9px; line-height:1.4;
  }

  /* Sections */
  main{max-width:1400px; margin:0 auto; padding:8px 22px 0}
  .section{padding:30px 0 8px; scroll-margin-top:150px}
  .section-head{
    display:flex; align-items:baseline; gap:14px;
    padding-bottom:14px; margin-bottom:20px;
    border-bottom:2px solid var(--lime);
  }
  .section-head h2{
    font-family:var(--serif); font-weight:800; font-size:27px; margin:0; color:var(--ivory);
  }
  .count{color:var(--muted); font-size:14px; font-weight:600}

  /* Grid */
  .grid{
    display:grid; gap:18px;
    grid-template-columns:repeat(auto-fill,minmax(210px,1fr));
  }
  .card{
    background:var(--panel); border:1px solid var(--line); border-radius:var(--radius);
    overflow:hidden; display:flex; flex-direction:column;
    transition:transform .1s ease, border-color .15s ease, box-shadow .15s ease;
    -webkit-tap-highlight-color:transparent;
  }
  .card:hover,.card:focus{
    transform:translateY(-3px); border-color:var(--lime);
    box-shadow:0 10px 28px rgba(0,0,0,.5), 0 0 0 1px rgba(155,188,14,.35);
  }
  .card:active{transform:translateY(-1px) scale(.995)}
  .thumb{
    aspect-ratio:1/1; background:var(--ink);
    display:flex; align-items:center; justify-content:center; overflow:hidden;
  }
  .thumb img{width:100%; height:100%; object-fit:cover; display:block}
  .pdf-thumb{
    background:linear-gradient(135deg,#1e1e1e,#101010);
    position:relative;
  }
  .pdf-badge{
    font-family:var(--serif); font-weight:800; font-size:34px; letter-spacing:.06em;
    color:var(--lime); border:2px solid var(--lime); border-radius:12px; padding:12px 20px;
  }
  .cap{
    padding:13px 14px; font-size:15px; font-weight:600; line-height:1.3;
    color:var(--ivory);
    border-top:1px solid var(--line);
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
    min-height:calc(1.3em * 2 + 26px);
  }

  footer{
    max-width:1400px; margin:44px auto 0; padding:26px 22px;
    border-top:1px solid var(--line); color:var(--muted); font-size:13px;
    display:flex; justify-content:space-between; gap:14px; flex-wrap:wrap;
  }
  footer .dot{color:var(--lime)}

  @media (max-width:640px){
    .brand img{height:42px}
    .brand-text h1{font-size:23px}
    .meta{display:none}
    .grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:13px}
    .nav{top:73px}
    .section{scroll-margin-top:132px}
  }
  /* Tablet (641–1024px) */
  @media (min-width:641px) and (max-width:1024px){
    .top-inner{padding:14px 20px}
    .brand-text h1{font-size:26px}
    .nav-inner{padding:10px 20px; gap:10px}
    main{padding:8px 20px 0}
    .grid{grid-template-columns:repeat(auto-fill,minmax(185px,1fr)); gap:15px}
    .section{scroll-margin-top:148px}
    .search-wrap{max-width:100%}
    #search{font-size:15px}
    .chip{padding:10px 16px; font-size:14px}
    footer{padding:20px 20px}
  }
  /* Lightbox */
  #lightbox{
    position:fixed; inset:0; z-index:200;
    background:#000; display:flex; flex-direction:column;
  }
  #lightbox[hidden]{display:none}
  #lb-bar{
    display:flex; align-items:center; gap:16px;
    padding:14px 20px; flex-shrink:0;
    background:rgba(0,0,0,.94); backdrop-filter:blur(14px);
    border-bottom:1px solid var(--line);
  }
  #lb-back{
    display:inline-flex; align-items:center; gap:8px;
    padding:11px 22px; border-radius:999px;
    background:var(--panel); border:1px solid var(--line);
    color:var(--ivory); font-family:var(--sans); font-size:15px; font-weight:700;
    cursor:pointer; transition:background .15s,border-color .15s,color .15s;
    flex-shrink:0; -webkit-tap-highlight-color:transparent; min-height:44px;
  }
  #lb-back:hover,#lb-back:focus{background:var(--panel-2); border-color:var(--lime); color:var(--lime)}
  #lb-back:active{transform:scale(.97)}
  #lb-info{flex:1; min-width:0; overflow:hidden}
  #lb-sec{
    font-family:var(--cond); font-size:13px; letter-spacing:.15em; text-transform:uppercase;
    color:var(--lime); font-weight:900; line-height:1; margin-bottom:5px;
  }
  #lb-title{
    font-family:var(--serif); font-size:19px; font-weight:700; font-style:italic;
    color:var(--ivory); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
    text-transform:capitalize;
  }
  #lb-stage{
    flex:1; display:flex; align-items:center; justify-content:center;
    padding:24px; overflow:auto; cursor:zoom-out;
  }
  #lb-img{
    max-width:100%; max-height:100%; object-fit:contain;
    border-radius:10px; box-shadow:0 24px 72px rgba(0,0,0,.85);
    cursor:default;
  }
  @media(max-width:640px){
    #lb-bar{padding:10px 14px; gap:10px}
    #lb-back{padding:9px 16px; font-size:14px}
    #lb-title{font-size:15px}
    #lb-stage{padding:12px}
  }
</style>
</head>
<body>
  <div id="lightbox" hidden role="dialog" aria-modal="true" aria-label="Pattern viewer">
    <div id="lb-bar">
      <button id="lb-back" type="button" aria-label="Back to gallery">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="M12 5l-7 7 7 7"/></svg>
        Back
      </button>
      <div id="lb-info">
        <div id="lb-sec"></div>
        <div id="lb-title"></div>
      </div>
    </div>
    <div id="lb-stage">
      <img id="lb-img" src="" alt="Pattern">
    </div>
  </div>
  <header class="top">
    <div class="top-inner">
      <div class="brand">
        <img src="/logo.png?v=${assetV}" alt="Fuzzywumpets">
        <div class="brand-text">
          <div class="kicker">Fuzzywumpets</div>
          <h1>Crystal Patterns</h1>
        </div>
      </div>
      <div class="meta">
        <div><b>${total}</b> patterns</div>
        <div>Synced ${esc(updated)} CT</div>
      </div>
    </div>
  </header>

  <nav class="nav" aria-label="Collar widths">
    <div class="nav-inner">
      <div class="search-wrap">
        <input id="search" type="search" placeholder="Search patterns by name/number…" autocomplete="off" spellcheck="false" aria-label="Search patterns">
        <button id="search-clear" type="button" aria-label="Clear search" hidden>&times;</button>
      </div>
      <div class="chips">${nav}</div>
    </div>
    <div id="noresults" class="noresults" hidden>No patterns match “<span id="nrq"></span>”.</div>
  </nav>

  <main>
    ${sections}
    <footer>
      <div>Fuzzywumpets <span class="dot">&bull;</span> Crystal Collar Patterns <span class="dot">&bull;</span> ${total} patterns</div>
      <div>Mirrored from Google Drive <span class="dot">&bull;</span> updated ${esc(updated)} CT</div>
    </footer>
  </main>
  <script>
  (function(){
    var q = document.getElementById('search');
    var clear = document.getElementById('search-clear');
    if(!q) return;
    var sections = [].slice.call(document.querySelectorAll('.section'));
    var chips = [].slice.call(document.querySelectorAll('.chip'));
    var nr = document.getElementById('noresults');
    var nrq = document.getElementById('nrq');
    function apply(){
      var term = (q.value||'').toLowerCase().trim();
      var totalShown = 0;
      // GLOBAL: every card in every section is filtered, not just the current folder.
      sections.forEach(function(sec){
        var cards = [].slice.call(sec.querySelectorAll('.card'));
        var shown = 0;
        cards.forEach(function(c){
          var hit = !term || (c.getAttribute('data-title')||'').indexOf(term) !== -1;
          c.style.display = hit ? '' : 'none';
          if(hit) shown++;
        });
        sec.style.display = shown ? '' : 'none';
        var cnt = sec.querySelector('.count');
        if(cnt) cnt.textContent = shown + (shown===1 ? ' pattern' : ' patterns');
        totalShown += shown;
      });
      chips.forEach(function(ch){
        var href = ch.getAttribute('href')||'';
        var sec = href.charAt(0)==='#' ? document.getElementById(href.slice(1)) : null;
        if(sec) ch.style.display = (sec.style.display==='none') ? 'none' : '';
      });
      if(nr){ nr.hidden = !(term && totalShown===0); if(nrq) nrq.textContent = q.value; }
      if(clear) clear.hidden = !term;
    }
    q.addEventListener('input', apply);
    if(clear) clear.addEventListener('click', function(){ q.value=''; apply(); q.focus(); });
    // ?q= deep link (so a search can be shared/bookmarked)
    var m = /[?&]q=([^&]+)/.exec(location.search);
    if(m){ q.value = decodeURIComponent(m[1].replace(/\\+/g,' ')); }
    apply();
  })();
  </script>
  <script>
  (function(){
    var lb  = document.getElementById('lightbox');
    var lbBack  = document.getElementById('lb-back');
    var lbImg   = document.getElementById('lb-img');
    var lbTitle = document.getElementById('lb-title');
    var lbSec   = document.getElementById('lb-sec');
    var lbStage = document.getElementById('lb-stage');
    if(!lb) return;
    function cap(s){ return (s||'').replace(/\\b\\w/g,function(c){return c.toUpperCase();}); }
    function openLightbox(card){
      var url   = card.getAttribute('href');
      var title = card.getAttribute('data-title')||'';
      var sec   = card.closest ? card.closest('.section') : null;
      var h2    = sec ? sec.querySelector('h2') : null;
      lbSec.textContent   = h2 ? h2.textContent : '';
      lbTitle.textContent = cap(title);
      lbImg.src = '';
      lb.removeAttribute('hidden');
      document.body.style.overflow = 'hidden';
      lbImg.src = url;
    }
    function closeLightbox(){
      lb.setAttribute('hidden','');
      document.body.style.overflow = '';
      lbImg.src = '';
    }
    [].forEach.call(document.querySelectorAll('.card'), function(card){
      card.addEventListener('click', function(e){ e.preventDefault(); openLightbox(card); });
    });
    lbBack.addEventListener('click', closeLightbox);
    lbStage.addEventListener('click', function(e){ if(e.target === lbStage) closeLightbox(); });
    document.addEventListener('keydown', function(e){ if(e.key==='Escape'&&!lb.hidden) closeLightbox(); });
  })();
  </script>
</body>
</html>`;
}

main();
