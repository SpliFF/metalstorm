// shoot_mech.mjs — mech turntable + animation-pose screenshots.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const model = process.argv[2] || '/out/fable_mech_png.gltf';
const prefix = process.argv[3] || 'mech';
const base = 'http://127.0.0.1:8899/preview/index.html';

const SHOTS = [
  { name: 'front34', q: 'az=210&el=14&dist=8' },
  { name: 'rear34', q: 'az=40&el=18&dist=8' },
  { name: 'side', q: 'az=270&el=6&dist=8' },
  { name: 'front', q: 'az=180&el=8&dist=7.5' },
  { name: 'aim', q: 'az=225&el=12&dist=8&yaw=50&pitch=-8' },
  { name: 'walk_contact', q: 'az=250&el=8&dist=8&clip=walk&t=0' },
  { name: 'walk_down', q: 'az=250&el=8&dist=8&clip=walk&t=0.17' },
  { name: 'walk_pass', q: 'az=250&el=8&dist=8&clip=walk&t=0.32' },
  { name: 'walk_lift', q: 'az=250&el=8&dist=8&clip=walk&t=0.5' },
  { name: 'walk_swing', q: 'az=250&el=8&dist=8&clip=walk&t=0.85' },
  { name: 'walk_34', q: 'az=215&el=14&dist=8&clip=walk&t=0.9' },
  { name: 'idle_scan', q: 'az=215&el=12&dist=8&clip=idle&t=1.3' },
  { name: 'death_buckle', q: 'az=240&el=14&dist=8&clip=death&t=0.7' },
  { name: 'death_down', q: 'az=240&el=14&dist=8&clip=death&t=1.75' },
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
  await page.screenshot({ path: `shots/${prefix}_${s.name}.png` });
  console.log(`[shoot] ${s.name} ok`);
}
await browser.close();
