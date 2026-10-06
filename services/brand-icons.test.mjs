import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import relay from './relay-worker.mjs';
import { accountPage, runReceiptPage } from './account-page.mjs';

const asset = (name) => fs.readFileSync(new URL(`../assets/brand/${name}`, import.meta.url));

test('the relay serves the brand icons from assets/brand, and its pages link them', async () => {
  for (const [path, type, file] of [['/favicon.svg', 'image/svg+xml', 'icon.svg'], ['/favicon.ico', 'image/png', 'favicon-32.png'],
    ['/apple-touch-icon.png', 'image/png', 'apple-touch-icon.png'], ['/icon-512.png', 'image/png', 'icon-512.png']]) {
    const response = await relay.fetch(new Request(`https://relay.test${path}`), {});
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('content-type'), type);
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(file.endsWith('.svg') ? body.toString().trim() : body.toString('base64'),
      file.endsWith('.svg') ? asset(file).toString().trim() : asset(file).toString('base64'), `${path} is stale; run node scripts/build-icons.mjs`);
  }
  for (const page of [accountPage(), runReceiptPage({ state: 'completed', subject: 'x', result: null })]) {
    assert.match(await page.text(), /<link rel="icon" href="\/favicon\.svg"/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  }
});
