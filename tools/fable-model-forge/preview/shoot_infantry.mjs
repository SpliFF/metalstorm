// shoot_infantry.mjs — turntable + top-down previews for the four infantry
// bodies. Uses a locally cached Chromium (playwright's own revision isn't
// cached here). usage: node preview/shoot_infantry.mjs
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';

const CACHED = [
  `${homedir()}/Library/Caches/ms-playwright/chromium-1148/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
  `${homedir()}/Library/Caches/ms-playwright/chromium-1208/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
];
const exe = CACHED.find(existsSync);

const MODELS = ['ms_soldiers_s1', 'ms_engineers_s1', 'ms_civilians', 'ms_militia'];
const base = 'http://127.0.0.1:8901/preview/index.html';
const SHOTS = [
  { name: 'front34', q: 'az=210&el=16&dist=4.2' },
  { name: 'side',    q: 'az=270&el=8&dist=4.2' },
  { name: 'front',   q: 'az=180&el=10&dist=4.0' },
  { name: 'rear',    q: 'az=0&el=12&dist=4.2' },
  { name: 'top',     q: 'az=200&el=64&dist=4.6' },
  { name: 'close',   q: 'az=225&el=12&dist=2.6' },
];

mkdirSync('shots/infantry', { recursive: true });
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
for (const stem of MODELS) {
  const model = `/out/${stem}_png.gltf`;
  for (const s of SHOTS) {
    const url = `${base}?model=${encodeURIComponent(model)}&${s.q}`;
    await page.goto(url);
    try {
      await page.waitForFunction('window.__done === true', null, { timeout: 30000 });
    } catch { console.error(`[shoot] ${stem} ${s.name}: timeout`); continue; }
    const err = await page.evaluate('window.__error');
    if (err) { console.error(`[shoot] ${stem} ${s.name}: ${err}`); continue; }
    const stats = await page.evaluate('window.__stats');
    await page.screenshot({ path: `shots/infantry/${stem}_${s.name}.png` });
    if (s.name === 'front34') console.log(`[shoot] ${stem}: tris=${stats.tris} calls=${stats.calls}`);
  }
}
await browser.close();
