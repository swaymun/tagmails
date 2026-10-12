import assert from 'node:assert/strict';
import test from 'node:test';
import relay from './relay-worker.mjs';
import { bindings } from './bindings-fixture.mjs';
import { handleDeviceLink } from './device-link.mjs';

const ORIGIN = 'https://relay.test';
const OWNER = { sub: 'google-sub-1', email: 'owner@gmail.com' };
const TOKEN = `tm_dev_${'a'.repeat(43)}`;

function setup() {
  const fixture = bindings();
  Object.assign(fixture.env, { GOOGLE_CLIENT_ID: 'tagmails-test.apps.googleusercontent.com', AGENT_DOMAIN: 'tagmails.test' });
  return fixture;
}

const link = (env, path, init = {}, { identity = OWNER, sendEmail = async () => ({}) } = {}) =>
  handleDeviceLink(new Request(`${ORIGIN}${path}`, init), env, { sendEmail,
    verifyIdentity: async (credential) => { if (credential !== 'google-ok') throw new Error('bad'); return identity; } });
const start = (env, body = { token: TOKEN, name: 'Studio Mac' }) => link(env, '/api/device/link', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const poll = (env, token = TOKEN) => link(env, '/api/device/link', { headers: { Authorization: `Bearer ${token}` } });
const approve = (env, code, { origin = ORIGIN, credential = 'google-ok', identity } = {}) => link(env, '/connect', {
  method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ credential, code }) },
{ identity });
const deviceStatus = (env, token = TOKEN) => relay.fetch(new Request(`${ORIGIN}/api/device/status`,
  { headers: { Authorization: `Bearer ${token}` } }), env);

test('a computer pairs once its owner opens the link, checks the code and signs in with Google', async () => {
  const { env, sqlite } = setup();
  env.SITE_ORIGIN = 'https://tagmails.com';
  const started = await start(env);
  assert.equal(started.status, 201);
  const { code, url } = await started.json();
  assert.match(code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.equal(url, `https://tagmails.com/connect?code=${code}`, 'the link carries the code, on the Site domain');
  assert.equal((await start(env)).status, 409, 'one link per device token');
  assert.deepEqual(await (await poll(env)).json(), { state: 'pending', code, url });
  assert.equal((await deviceStatus(env)).status, 401, 'not paired before approval');

  const page = await link(env, `/connect?code=${code}`);
  const html = await page.text();
  assert.match(html, /Connect “Studio Mac” to Tagmails/, 'the page names the computer before approval');
  assert.ok(html.includes(`<strong>${code}</strong>`), 'and shows the code to check against the terminal');
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(await (await link(env, '/connect?code=BBBB-BBBB')).text(), /That link has expired or was already used/);

  assert.equal((await approve(env, code, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await approve(env, code, { credential: 'forged' })).status, 401);
  assert.equal((await approve(env, 'BBBB-BBBB')).status, 404);
  const approved = await approve(env, code.toLowerCase().replace('-', ' '));
  assert.deepEqual(await approved.json(), { name: 'Studio Mac', agentEmail: 'agent@wonder.test' });
  assert.equal((await approve(env, code)).status, 404, 'a code works once');
  assert.deepEqual(await (await poll(env)).json(), { state: 'approved' });
  assert.equal((await deviceStatus(env)).status, 200);
  const device = sqlite.prepare('SELECT account_id, name FROM devices').get();
  assert.deepEqual({ ...device }, { account_id: 'account-1', name: 'Studio Mac' });
});

test('expired links, strangers on a private relay and bad requests pair nothing', async () => {
  const { env, sqlite } = setup();
  delete env.PUBLIC_SIGNUP_ENABLED;
  env.PILOT_OWNER_EMAIL = 'owner@gmail.com';
  const { code } = await (await start(env)).json();
  const stranger = { sub: 'google-sub-9', email: 'stranger@gmail.com' };
  assert.equal((await approve(env, code, { identity: stranger })).status, 403);
  assert.equal((await (await poll(env)).json()).state, 'pending', 'a refused sign-in leaves the code usable');
  sqlite.prepare("UPDATE device_links SET expires_at = datetime('now', '-1 minute')").run();
  assert.equal((await poll(env)).status, 410);
  assert.equal((await approve(env, code)).status, 404);
  assert.equal(sqlite.prepare('SELECT COUNT(*) AS n FROM devices').get().n, 0);
  assert.equal((await poll(env, `tm_dev_${'b'.repeat(43)}`)).status, 404);
  for (const body of [{ token: 'tm_dev_short', name: 'Mac' }, { token: `tm_dev_${'c'.repeat(43)}`, name: '' },
    { token: `tm_dev_${'c'.repeat(43)}`, name: 'Mac', publicKey: 'not-a-key' }]) {
    assert.equal((await start(env, body)).status, 400, JSON.stringify(body));
  }
});

test('skill.md tells an agent how to pair, adding --relay only for a self-hosted relay', async () => {
  const { env } = setup();
  env.PUBLIC_ORIGIN = 'https://tagmails-relay-dev.saimun-shahee.workers.dev';
  env.SITE_ORIGIN = 'https://tagmails.com';
  const hosted = await (await relay.fetch(new Request(`${ORIGIN}/skill.md`), env)).text();
  assert.match(hosted, /^---\nname: tagmails\n/);
  assert.match(hosted, /run `tagmails pair --no-wait`\. It prints a link \(https:\/\/tagmails\.com\/connect\?code=…\)/);
  env.PUBLIC_ORIGIN = 'https://tagmails-selfhost.example.workers.dev';
  delete env.SITE_ORIGIN;
  const selfHosted = await (await relay.fetch(new Request(`${ORIGIN}/skill.md`), env)).text();
  assert.match(selfHosted, /`tagmails pair --no-wait --relay https:\/\/tagmails-selfhost\.example\.workers\.dev`/);
});
