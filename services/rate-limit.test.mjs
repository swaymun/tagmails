import assert from 'node:assert/strict';
import test from 'node:test';
import relay from './relay-worker.mjs';
import { bindings } from './bindings-fixture.mjs';
import { handleDeviceRequest } from './device-jobs.mjs';

// Mimics a Workers rate limiting binding: `limit` allowed calls per key.
function limiter(limit) {
  const counts = new Map();
  return { counts, async limit({ key }) { counts.set(key, (counts.get(key) ?? 0) + 1); return { success: counts.get(key) <= limit }; } };
}
const from = (ip, init = {}) => ({ ...init, headers: { 'cf-connecting-ip': ip, ...(init.headers ?? {}) } });

test('public pages and webhooks are limited per IP', async () => {
  const { env } = bindings();
  env.PUBLIC_RATE_LIMIT = limiter(2);
  const page = (ip) => relay.fetch(new Request('https://relay.test/account', from(ip)), env);
  assert.equal((await page('1.1.1.1')).status, 200);
  assert.equal((await page('1.1.1.1')).status, 200);
  const blocked = await page('1.1.1.1');
  assert.equal(blocked.status, 429);
  assert.equal(blocked.headers.get('retry-after'), '60');
  assert.equal((await page('2.2.2.2')).status, 200, 'another IP is unaffected');
  const webhook = await relay.fetch(new Request('https://relay.test/webhooks/resend', from('1.1.1.1', { method: 'POST', body: '{}' })), env);
  assert.equal(webhook.status, 429);
  assert.equal((await relay.fetch(new Request('https://relay.test/favicon.svg', from('1.1.1.1')), env)).status, 200, 'icons are not counted');
});

test('sign-in, pairing and bad device tokens share a strict limit; good tokens are never counted', async () => {
  const { env } = bindings();
  env.AUTH_RATE_LIMIT = limiter(2);
  const pair = () => relay.fetch(new Request('https://relay.test/api/device/pair', from('3.3.3.3', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })), env);
  assert.equal((await pair()).status, 400);
  assert.equal((await pair()).status, 400);
  assert.equal((await pair()).status, 429);
  const claim = (token) => handleDeviceRequest(new Request('https://relay.test/api/device/claim', from('4.4.4.4', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` } })), env);
  const bad = `tm_dev_${'x'.repeat(43)}`;
  assert.equal((await claim(bad)).status, 401);
  assert.equal((await claim(bad)).status, 401);
  assert.equal((await claim(bad)).status, 429);
  assert.equal(env.AUTH_RATE_LIMIT.counts.get('device:4.4.4.4'), 3);
});

test('without a binding nothing is limited, and a limiter error fails open', async () => {
  const { env } = bindings();
  for (let index = 0; index < 5; index += 1) {
    assert.equal((await relay.fetch(new Request('https://relay.test/account'), env)).status, 200);
  }
  env.PUBLIC_RATE_LIMIT = { limit: async () => { throw new Error('down'); } };
  assert.equal((await relay.fetch(new Request('https://relay.test/account'), env)).status, 200);
});
