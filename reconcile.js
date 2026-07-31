// reconcile.js — report how many manifest files are missing on disk.
// Prints the count to stdout (used by sync.sh). Exits 0 always.
'use strict';
const fs = require('fs');
const path = require('path');
const EXT_BY_MIME = {
  'image/jpeg':'jpg','image/png':'png','image/gif':'gif','image/webp':'webp',
  'image/heif':'jpg','image/heic':'jpg','application/pdf':'pdf',
};
try {
  const m = JSON.parse(fs.readFileSync(path.join(__dirname,'data','manifest.json'),'utf8'));
  let missing = 0, present = 0;
  for (const sec of m.sections) for (const f of sec.files) {
    const ext = EXT_BY_MIME[f.mime] || 'jpg';
    const abs = path.join(__dirname,'public','patterns',sec.slug,`${f.id}.${ext}`);
    if (fs.existsSync(abs) && fs.statSync(abs).size>0) present++; else missing++;
  }
  process.stderr.write(`reconcile: ${present} present, ${missing} missing\n`);
  console.log(missing);
} catch(e){ console.log('?'); }
