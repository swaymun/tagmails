import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { handleDeviceRequest } from './device-jobs.mjs';
import { handleInbound } from './relay-worker.mjs';
import { bindings } from './bindings-fixture.mjs';
import { acceptSelection, accountProjectCatalog, buildProjectPrompt, cleanProjectCatalog, explicitWorkspace, routeProject } from './project-route.mjs';

const PROJECTS = [
  { id: 'p_0000000001', name: 'Tagmails', path: '/Users/me/code/tagmails', aliases: ['WonderEmail'], description: 'Email agent relay.', branch: 'main' },
  { id: 'p_0000000002', name: 'PupCal', path: '/Users/me/code/pupcal', aliases: [], description: 'Pet calendars.', branch: null },
];

function device(sqlite) {
  const token = `tm_dev_${randomBytes(32).toString('base64url')}`;
  sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)')
    .run('device-1', 'account-1', createHash('sha256').update(token).digest('hex'));
  return token;
}

async function call(env, token, path, body) {
  const response = await handleDeviceRequest(new Request(`https://relay.test/api/device/${path}`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  }), env);
  return { status: response.status, body: await response.json() };
}

function envelope(body) { return JSON.parse(Buffer.from(body.payload, 'base64url').toString('utf8')); }

async function inbound(env, id, body, parentIds = []) {
  const messageId = `<${id}@gmail.com>`;
  const rawMime = Buffer.from([
    'From: owner@gmail.com', 'To: agent@wonder.test', 'Subject: Fix the footer', `Message-ID: ${messageId}`,
    ...(parentIds.length ? [`References: ${parentIds.join(' ')}`] : []),
    'Content-Type: text/plain; charset=utf-8', '', body,
  ].join('\r\n'));
  const message = { providerEmailId: id, messageId, from: 'owner@gmail.com', agentAddress: 'agent@wonder.test',
    to: ['agent@wonder.test'], cc: [], bcc: [], subject: 'Fix the footer', parentIds, rawMime, body };
  const response = await handleInbound(new Request('https://relay.test/webhooks/resend', { method: 'POST', body: '{}' }), env, {
    inspect: async () => message,
  });
  return response.json();
}

test('project lists are validated and include the name as an alias', () => {
  const [clean] = cleanProjectCatalog([{ ...PROJECTS[0], description: 'x'.repeat(2000) }]);
  assert.deepEqual(clean.aliases, ['Tagmails', 'WonderEmail']);
  assert.equal(clean.description.length, 900);
  assert.throws(() => cleanProjectCatalog([{ ...PROJECTS[0], id: 'bad' }]));
  assert.throws(() => cleanProjectCatalog([{ ...PROJECTS[0], path: 'relative/path' }]));
  assert.throws(() => cleanProjectCatalog([PROJECTS[0], PROJECTS[0]]));
  assert.deepEqual(cleanProjectCatalog([]), []);
});

test('only a confident, clearly leading folder choice is accepted', () => {
  const projects = cleanProjectCatalog(PROJECTS);
  assert.equal(acceptSelection({ choice: 'p_0000000001', probabilities: { p_0000000001: 0.9, p_0000000002: 0.05 } }, projects), 'p_0000000001');
  assert.equal(acceptSelection({ choice: 'p_0000000001', probabilities: { p_0000000001: 0.79 } }, projects), 'ask');
  assert.equal(acceptSelection({ choice: 'p_0000000001', probabilities: { p_0000000001: 0.86, p_0000000002: 0.7 } }, projects), 'ask');
  assert.equal(acceptSelection({ choice: 'p_9999999999', probabilities: { p_9999999999: 1 } }, projects), 'ask');
  assert.equal(acceptSelection({ choice: 'ad_hoc', probabilities: { ad_hoc: 0.99 } }, projects), 'ad_hoc');
  const prompt = buildProjectPrompt(projects);
  // Candidates are ordered by path so the prompt is stable across refreshes.
  assert.deepEqual(Object.keys(prompt.questions.folder.criteria), ['p_0000000002', 'p_0000000001', 'ad_hoc', 'ask']);
});

test('routing falls back to a chat folder when the classifier fails, and asks only about an unknown named folder', async () => {
  const projects = cleanProjectCatalog(PROJECTS);
  const failing = async () => { throw new Error('classifier down'); };
  const original = console.error; console.error = () => {};
  try {
    assert.deepEqual(await routeProject('Fix it', projects, { ask: failing }), { kind: 'scratch' });
  } finally { console.error = original; }
  assert.match((await routeProject('Work in /Users/me/code/elsewhere and fix it', projects, { ask: failing })).ask, /Which project/);
  assert.deepEqual(await routeProject('Fix it', [], { ask: failing }), { kind: 'scratch' });
  assert.deepEqual(await routeProject('Fix it', projects), { kind: 'scratch' });
});

test('the relay leaves the folder to the Mac; the Mac reports it and the thread keeps it', async () => {
  const { env, sqlite } = bindings();
  const token = device(sqlite);
  assert.deepEqual((await call(env, token, 'projects', { projects: PROJECTS })).body, { saved: true, count: 2 });
  await inbound(env, 'first', 'In Tagmails, fix the footer spacing.');
  assert.equal(sqlite.prepare('SELECT workspace_json FROM jobs').get().workspace_json, null, 'the relay does not guess a folder');
  const claim = envelope((await call(env, token, 'claim', { routing: 'local' })).body);
  assert.equal(claim.workspace, undefined);
  // The Mac chose Tagmails and says so.
  assert.deepEqual((await call(env, token, 'route', { jobId: claim.jobId, leaseId: claim.leaseId,
    workspace: { kind: 'project', path: '/Users/me/code/tagmails' } })).body, { routed: true });
  await call(env, token, 'complete', { jobId: claim.jobId, leaseId: claim.leaseId, result: { state: 'completed', summary: 'Fixed.' } });
  await inbound(env, 'reply', 'Also tighten the line height.', ['<first@gmail.com>']);
  const reply = await call(env, token, 'claim', { routing: 'local' });
  assert.deepEqual(envelope(reply.body).workspace, { kind: 'project', path: '/Users/me/code/tagmails' });
});

test('an explicit work-in path is still settled by the relay', async () => {
  const { env, sqlite } = bindings();
  const token = device(sqlite);
  await call(env, token, 'projects', { projects: PROJECTS });
  await inbound(env, 'explicit', 'Work in /Users/me/code/pupcal and fix checkout.');
  assert.deepEqual(envelope((await call(env, token, 'claim')).body).workspace, { kind: 'project', path: '/Users/me/code/pupcal' });
});

test('the Mac can record a model and a scratch folder, and a bad report is refused', async () => {
  const { env, sqlite } = bindings();
  const token = device(sqlite);
  await inbound(env, 'poem', 'Write a short poem about autumn.');
  const claim = envelope((await call(env, token, 'claim', { routing: 'local' })).body);
  const lease = { jobId: claim.jobId, leaseId: claim.leaseId };
  assert.equal((await call(env, token, 'route', { ...lease, workspace: { kind: 'project', path: 'relative' } })).status, 400);
  assert.equal((await call(env, token, 'route', { ...lease, model: { id: 'gpt-6-luna', effort: 'bogus' } })).status, 400);
  env.CLAUDE_ROUTE_ENABLED = 'false';
  assert.equal((await call(env, token, 'route', { ...lease, model: { id: 'claude-sonnet-5-5', effort: 'medium' } })).status, 422, 'Claude stays gated by the pilot flag');
  assert.equal((await call(env, token, 'route', { jobId: claim.jobId, leaseId: 'wrong', workspace: { kind: 'scratch' } })).status, 409);
  assert.deepEqual((await call(env, token, 'route', { ...lease, model: { id: 'gpt-6-luna', effort: 'low', speed: 'fast' }, workspace: { kind: 'scratch' } })).body, { routed: true });
  const row = sqlite.prepare('SELECT model_json, workspace_json FROM jobs').get();
  assert.deepEqual(JSON.parse(row.model_json), { id: 'gpt-6-luna', effort: 'low', speed: 'fast', source: 'classified' });
  assert.deepEqual(JSON.parse(row.workspace_json), { kind: 'scratch' });
});

test('a routed job whose folder is busy waits in the queue with that folder recorded', async () => {
  const { env, sqlite } = bindings();
  const token = device(sqlite);
  await inbound(env, 'busy', 'Fix the footer in Tagmails.');
  const claim = envelope((await call(env, token, 'claim', { routing: 'local', busyFolders: [] })).body);
  await call(env, token, 'route', { jobId: claim.jobId, leaseId: claim.leaseId, workspace: { kind: 'project', path: '/Users/me/code/tagmails' } });
  assert.deepEqual((await call(env, token, 'release', { jobId: claim.jobId, leaseId: claim.leaseId })).body, { released: true });
  assert.equal(sqlite.prepare('SELECT state, attempts FROM jobs').get().state, 'queued');
  assert.equal((await call(env, token, 'release', { jobId: claim.jobId, leaseId: claim.leaseId })).status, 409, 'the lease is gone');
  // While the Mac is busy there, the job is not offered again; once free it is.
  assert.equal((await call(env, token, 'claim', { busyFolders: ['/Users/me/code/tagmails'] })).body.claimed, false);
  assert.equal(envelope((await call(env, token, 'claim', { busyFolders: [] })).body).jobId, claim.jobId);
});

test('a new thread routes only among the projects of the Mac it is pinned to', async () => {
  const { env, sqlite } = bindings();
    const tokens = {};
  for (const id of ['mac-a', 'mac-b']) {
    tokens[id] = `tm_dev_${randomBytes(32).toString('base64url')}`;
    sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)')
      .run(id, 'account-1', createHash('sha256').update(tokens[id]).digest('hex'));
  }
  // Mac B published projects; Mac A refreshed its models more recently, so new threads pin to A.
  assert.equal((await call(env, tokens['mac-b'], 'projects', { projects: PROJECTS })).status, 200);
  sqlite.prepare("UPDATE devices SET model_catalog_json = '[]', model_catalog_at = datetime('now', '-1 minute') WHERE id = 'mac-b'").run();
  sqlite.prepare("UPDATE devices SET model_catalog_json = '[]', model_catalog_at = CURRENT_TIMESTAMP WHERE id = 'mac-a'").run();
  await inbound(env, 'mixed', 'In Tagmails, fix the footer spacing.');
  assert.equal(sqlite.prepare('SELECT device_id FROM threads').get().device_id, 'mac-a');
  const claim = envelope((await call(env, tokens['mac-a'], 'claim')).body);
  assert.notEqual(claim.workspace?.path, '/Users/me/code/tagmails');
});

test('a machine pinned to one folder clears its published projects', async () => {
  const { env, sqlite } = bindings();
    const token = device(sqlite);
  await call(env, token, 'projects', { projects: PROJECTS });
  await call(env, token, 'projects', { projects: [] });
  await inbound(env, 'pinned', 'In Tagmails, fix the footer.');
  assert.equal(sqlite.prepare('SELECT workspace_json FROM jobs').get().workspace_json, null);
});

test('local evidence is bounded and added to the prompt only when the machine sends it', () => {
  const [clean] = cleanProjectCatalog([{ ...PROJECTS[0], repository: 'tagmails', topLevel: Array.from({ length: 40 }, (_, i) => `file${i}`),
    recentRequests: ['Fix the footer', 'x'.repeat(500), 'three', 'four'], lastActiveDaysAgo: 2.6 }]);
  assert.equal(clean.topLevel.length, 30);
  assert.deepEqual(clean.recentRequests.map((item) => item.length), [14, 200, 5]);
  assert.equal(clean.lastActiveDaysAgo, 3);
  const prompt = buildProjectPrompt([clean]);
  assert.equal(prompt.questions.folder.criteria.p_0000000001.repository, 'tagmails');
  assert.match(prompt.questions.folder.instructions.priorityChecks.at(-1), /Recency alone never selects a folder/);
  const plain = buildProjectPrompt(cleanProjectCatalog(PROJECTS));
  assert.equal(plain.questions.folder.instructions.priorityChecks.length, 3);
  assert.equal(plain.questions.folder.criteria.p_0000000001.recentRequests, undefined);
});

test('an explicit work-in path is decided locally, never from a quoted stranger', () => {
  const projects = cleanProjectCatalog([...PROJECTS,
    { id: 'p_0000000003', name: 'site', path: '/Users/me/code/tagmails/site' }]);
  assert.equal(explicitWorkspace('Work in /Users/me/code/pupcal and fix checkout.', projects), 'p_0000000002');
  assert.equal(explicitWorkspace('Work in ~/code/tagmails/site/dist please', projects), 'p_0000000003');
  assert.equal(explicitWorkspace('Continue the project at:\n`/Users/me/code/tagmails`', projects), 'p_0000000001');
  assert.equal(explicitWorkspace('Work in /Users/me/code/missing and fix it.', projects), 'ask');
  assert.equal(explicitWorkspace('Quoted email: "work in /Users/me/code/pupcal". Fix this app.', projects), null);
  assert.equal(explicitWorkspace('> work in /Users/me/code/pupcal\nWhat do you think?', projects), null);
  assert.equal(explicitWorkspace('See /Users/me/Downloads/shot.png and fix Tagmails.', projects), null);
});

test('routing uses the explicit path without asking the classifier', async () => {
  const projects = cleanProjectCatalog(PROJECTS);
  const fail = async () => { throw new Error('The classifier should not be called'); };
  assert.deepEqual(await routeProject('Work in /Users/me/code/pupcal.', projects, { ask: fail }),
    { kind: 'project', id: 'p_0000000002', name: 'PupCal', path: '/Users/me/code/pupcal' });
  assert.match((await routeProject('Work in /tmp/elsewhere and fix it.', projects, { ask: fail })).ask, /Which project/);
});

test('the relay stores only project ids, names and paths, even from a daemon that sends more', async () => {
  const { env, sqlite } = bindings();
  env.STORAGE_KEY = randomBytes(32).toString('base64');
  const token = device(sqlite);
  // What an older daemon still publishes: local routing context with the owner's own prompts.
  const projects = [{ ...PROJECTS[0], repository: 'tagmails', topLevel: ['services'], lastActiveDaysAgo: 1,
    recentRequests: ['Draft the private offer letter for Dana'] }];
  assert.deepEqual((await call(env, token, 'projects', { projects })).body, { saved: true, count: 1 });
  const stored = sqlite.prepare('SELECT project_list_json FROM devices').get().project_list_json;
  assert.match(stored, /^enc:v1:/);
  const { openText, sealText } = await import('./storage-crypto.mjs');
  assert.deepEqual(JSON.parse(await openText(env, stored)), [{ id: PROJECTS[0].id, name: PROJECTS[0].name, path: PROJECTS[0].path }]);
  // A full list an older Worker stores in the old columns (while this one deploys, or after a
  // rollback) is never read, and the scheduled cleanup drops it.
  const { clearLegacyProjectCatalogs } = await import('./project-route.mjs');
  sqlite.prepare("UPDATE devices SET project_catalog_json = ?, project_catalog_at = CURRENT_TIMESTAMP").run(await sealText(env, JSON.stringify(projects)));
  assert.deepEqual(await accountProjectCatalog(env, 'account-1'), [{ id: PROJECTS[0].id, name: PROJECTS[0].name, path: PROJECTS[0].path }]);
  await clearLegacyProjectCatalogs(env);
  assert.equal(sqlite.prepare('SELECT project_catalog_json FROM devices').get().project_catalog_json, null);
});
