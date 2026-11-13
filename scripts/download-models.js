'use strict';
// Downloads the speech and transcription models into ./models. Run with: npm run setup
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { DOWNLOADS } = require('../src/models');

const dir = path.join(__dirname, '..', 'models');

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  let lastPct = -10;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    if (!total) return;
    const pct = Math.floor((done / total) * 100);
    if (pct >= lastPct + 10) {
      lastPct = pct;
      console.log(`  ${pct}% of ${(total / 1e6).toFixed(0)} MB`);
    }
  });
  await pipeline(body, fs.createWriteStream(dest + '.part'));
  fs.renameSync(dest + '.part', dest);
}

(async () => {
  fs.mkdirSync(dir, { recursive: true });
  for (const item of DOWNLOADS) {
    const marker = path.join(dir, item.check || item.file);
    if (fs.existsSync(marker)) {
      console.log(`Already present: ${item.label}`);
      continue;
    }
    console.log(`Downloading: ${item.label}`);
    const dest = path.join(dir, item.file);
    await download(item.url, dest);
    if (item.extract) {
      console.log('  Extracting...');
      const into = item.into ? path.join(dir, item.into) : dir;
      fs.mkdirSync(into, { recursive: true });
      // Windows ships bsdtar, which unpacks both .tar.bz2 and .zip. Name it
      // explicitly so a GNU tar earlier on PATH (Git Bash) is not picked up.
      const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\Windows', 'System32', 'tar.exe') : 'tar';
      execFileSync(tar, ['-xf', dest, '-C', into], { stdio: 'inherit' });
      fs.unlinkSync(dest);
    }
  }
  console.log('Models are ready.');
})().catch((err) => {
  console.error('Model download failed:', err.message);
  process.exit(1);
});
