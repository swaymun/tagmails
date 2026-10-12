// Renders the README images at 2x: the three mock Gmail threads in
// assets/readme/threads.html and light/dark wordmarks from assets/brand/wordmark.svg.
//
//   node scripts/render-readme-shots.mjs
//
// Needs Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`);
// it isn't a project dependency. Set PLAYWRIGHT_MODULE to its index.mjs if Node can't find it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', '/opt/homebrew/lib/node_modules/playwright/index.mjs',
  '/usr/local/lib/node_modules/playwright/index.mjs'].filter(Boolean);
let chromium;
for (const name of candidates) {
  try { ({ chromium } = await import(name.startsWith('/') ? pathToFileURL(name).href : name)); break; } catch {}
}
if (!chromium) throw new Error('Playwright not found; see the comment at the top of this script.');

const out = path.join(root, 'assets/readme');
// Falls back to installed Google Chrome when Playwright's own Chromium is missing.
const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 800, height: 600 } });

for (const scene of ['ask', 'steer', 'file']) {
  await page.goto(`${pathToFileURL(path.join(out, 'threads.html')).href}?scene=${scene}`);
  await page.locator(`#${scene}`).screenshot({ path: path.join(out, `${scene}.png`) });
}

// GitHub picks light or dark through <picture>; SVG media queries follow the OS, not GitHub's theme.
const svg = fs.readFileSync(path.join(root, 'assets/brand/wordmark.svg'), 'utf8').replace(/<style>.*<\/style>/s, '');
for (const [name, word, dot] of [['wordmark-light', '#1d2420', '#7aa33a'], ['wordmark-dark', '#eef1ec', '#d0f06c']]) {
  const themed = svg.replace('class="word"', `fill="${word}"`).replace('class="dot"', `fill="${dot}"`);
  await page.setContent(`<body style="margin:0;background:transparent"><div id="mark" style="display:inline-block;width:268px;height:64px">${themed}</div></body>`);
  await page.locator('#mark').screenshot({ path: path.join(out, `${name}.png`), omitBackground: true });
}

await browser.close();
for (const file of fs.readdirSync(out).filter((name) => name.endsWith('.png'))) {
  console.log(`${file}\t${Math.round(fs.statSync(path.join(out, file)).size / 1024)} KB`);
}
