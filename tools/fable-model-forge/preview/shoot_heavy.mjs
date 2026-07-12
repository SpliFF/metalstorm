// shoot_heavy.mjs — headless screenshots of fable_heavy (20 m unit).
// usage: node preview/shoot_heavy.mjs [modelPath] [outPrefix]
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const model = process.argv[2] || '/out/fable_heavy_png.gltf';
const prefix = process.argv[3] || 'heavy';
const base = 'http://127.0.0.1:8899/preview/index.html';

const SHOTS = [
  { name: 'front34', q: 'az=210&el=16&dist=30' },
  { name: 'rear34', q: 'az=40&el=20&dist=30' },
  { name: 'side', q: 'az=270&el=8&dist=30' },
  { name: 'front', q: 'az=180&el=10&dist=28' },
  { name: 'top', q: 'az=200&el=62&dist=32' },
  { name: 'aim', q: 'az=225&el=14&dist=30&yaw=40&pitch=-8' },
  { name: 'close', q: 'az=235&el=12&dist=16' },
  { name: 'closefront', q: 'az=195&el=10&dist=14' },
  { name: 'sponson', q: 'az=150&el=18&dist=18' },
];

mkdirSync('shots', { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--use-angle=swiftshader', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
page.on('console', (m) => { if (m.type() === 'error') console.log('[page]', m.text()); });
for (const s of SHOTS) {
  const url = `${base}?model=${encodeURIComponent(model)}&${s.q}`;
  await page.goto(url);
  await page.waitForFunction('window.__done === true', null, { timeout: 30000 });
  const err = await page.evaluate('window.__error');
  if (err) { console.error(`[shoot] ${s.name}: ${err}`); continue; }
  const stats = await page.evaluate('window.__stats');
  await page.screenshot({ path: `shots/${prefix}_${s.name}.png` });
  console.log(`[shoot] ${s.name}: tris=${stats.tris} calls=${stats.calls} size=${stats.size}`);
}
await browser.close();
