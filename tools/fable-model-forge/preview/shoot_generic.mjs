// shoot_generic.mjs — turntable previews for any list of stems.
// usage: node preview/shoot_generic.mjs <outdir> <stem> [stem...]
// Serves nothing itself — expects `python3 -m http.server 8901` at repo root
// of fable-model-forge (so /out/<stem>_png.gltf resolves).
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';

const CACHED = [
  `${homedir()}/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
  `${homedir()}/Library/Caches/ms-playwright/chromium-1208/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
];
const exe = CACHED.find(existsSync);

const [outdir, ...models] = process.argv.slice(2);
if (!outdir || !models.length) {
  console.error('usage: node preview/shoot_generic.mjs <outdir> <stem> [stem...]');
  process.exit(1);
}
const base = 'http://127.0.0.1:8901/preview/index.html';
const SHOTS = [
  { name: 'front34', q: 'az=210&el=18' },
  { name: 'rear34',  q: 'az=45&el=18' },
  { name: 'top',     q: 'az=200&el=62' },
];

mkdirSync(outdir, { recursive: true });
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
for (const stem of models) {
  const model = `/out/${stem}_png.gltf`;
  for (const s of SHOTS) {
    const url = `${base}?model=${encodeURIComponent(model)}&${s.q}`;
    await page.goto(url);
    try {
      await page.waitForFunction('window.__done === true', null, { timeout: 45000 });
    } catch { console.error(`[shoot] ${stem} ${s.name}: timeout`); continue; }
    const err = await page.evaluate('window.__error');
    if (err) { console.error(`[shoot] ${stem} ${s.name}: ${err}`); continue; }
    await page.screenshot({ path: `${outdir}/${stem}_${s.name}.png` });
  }
  console.log(`[shoot] ${stem} done`);
}
await browser.close();
