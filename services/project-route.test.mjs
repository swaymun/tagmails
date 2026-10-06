import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';
import { handleDeviceRequest } from './device-jobs.mjs';
import { handleInbound } from './relay-worker.mjs';
import { bindings } from './bindings-fixture.mjs';
import { acceptSelection, buildProjectPrompt, cleanProjectCatalog, explicitWorkspace, routeProject } from './project-route.mjs';

const PROJECTS = [
  { id: 'p_0000000001', name: 'TagMails', path: '/Users/me/code/tagmails', aliases: ['WonderEmail'], description: 'Email agent relay.', branch: 'main' },
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

// A fake Jev that answers the folder question with `folder` and leaves model routing alone.
function jev(folder, seen = []) {
  return async (_url, init) => {
    const request = JSON.parse(init.body);
    seen.push(request);
    const answers = request.questions.folder
      ? { folder: { type: 'choice', choice: folder, probabilities: { [folder]: 0.95 } } }
      : { route: { type: 'choice', choice: 'none', probabilities: { none: 0.9 } } };
    return Response.json({ answers });
  };
}

async function inbound(env, id, body, parentIds = [], fetchModel) {
  const messageId = `<${id}@gmail.com>`;
  const rawMime = Buffer.from([
    'From: owner@gmail.com', 'To: agent@wonder.test', 'Subject: Fix the footer', `Message-ID: ${messageId}`,
    ...(parentIds.length ? [`References: ${parentIds.join(' ')}`] : []),
    'Content-Type: text/plain; charset=utf-8', '', body,
  ].join('\r\n'));
  const message = { providerEmailId: id, messageId, from: 'owner@gmail.com', agentAddress: 'agent@wonder.test',
    to: ['agent@wonder.test'], cc: [], bcc: [], subject: 'Fix the footer', parentIds, rawMime, body };
  const response = await handleInbound(new Request('https://relay.test/webhooks/resend', { method: 'POST', body: '{}' }), env, {
    inspect: async () => message, fetchModel,
  });
  return response.json();
}

test('project lists are validated and include the name as an alias', () => {
  const [clean] = cleanProjectCatalog([{ ...PROJECTS[0], description: 'x'.repeat(2000) }]);
  assert.deepEqual(clean.aliases, ['TagMails', 'WonderEmail']);
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

test('routing falls back to a chat folder when Jev fails, and asks only about an unknown named folder', async () => {
  const projects = cleanProjectCatalog(PROJECTS);
  const failing = async () => new Response('down', { status: 503 });
  const original = console.error; console.error = () => {};
  try {
    assert.deepEqual(await routeProject('Fix it', projects, { apiKey: 'k', fetcher: failing }), { kind: 'scratch' });
  } finally { console.error = original; }
  assert.match((await routeProject('Work in /Users/me/code/elsewhere and fix it', projects, { apiKey: 'k', fetcher: failing })).ask, /Which project/);
  assert.deepEqual(await routeProject('Fix it', [], { apiKey: 'k', fetcher: failing }), { kind: 'scratch' });
});

test('a new email runs in the chosen published folder and replies stay there', async () => {
  const { env, sqlite } = bindings();
  env.TYPESAFE_API_KEY = 'jev-test';
  const token = device(sqlite);
  assert.deepEqual((await call(env, token, 'projects', { projects: PROJECTS })).body, { saved: true, count: 2 });
  const seen = [];
  await inbound(env, 'first', 'In TagMails, fix the footer spacing.', [], jev('p_0000000001', seen));
  const folderCalls = seen.filter((request) => request.questions.folder);
  assert.equal(folderCalls.length, 1);
  assert.match(folderCalls[0].state, /^New request:\nSubject: Fix the footer\nIn TagMails/);
  const claim = await call(env, token, 'claim');
  assert.deepEqual(envelope(claim.body).workspace, { kind: 'project', path: '/Users/me/code/tagmails' });
  await call(env, token, 'complete', { jobId: envelope(claim.body).jobId, leaseId: envelope(claim.body).leaseId,
    result: { state: 'completed', summary: 'Fixed.' } });

  const later = [];
  await inbound(env, 'reply', 'Also tighten the line height.', ['<first@gmail.com>'], jev('p_0000000002', later));
  assert.equal(later.filter((request) => request.questions.folder).length, 0);
  const reply = await call(env, token, 'claim');
  assert.deepEqual(envelope(reply.body).workspace, { kind: 'project', path: '/Users/me/code/tagmails' });
});

test('standalone and unclear work both run in a chat folder instead of asking', async () => {
  const { env, sqlite } = bindings();
  env.TYPESAFE_API_KEY = 'jev-test';
  const token = device(sqlite);
  await call(env, token, 'projects', { projects: PROJECTS });
  await inbound(env, 'poem', 'Write a short poem about autumn.', [], jev('ad_hoc'));
  assert.deepEqual(envelope((await call(env, token, 'claim')).body).workspace, { kind: 'scratch' });
  await inbound(env, 'vague', 'Fix the app.', [], jev('ask'));
  const vague = sqlite.prepare("SELECT model_json, workspace_json FROM jobs j JOIN messages m ON m.id = j.message_id WHERE m.provider_email_id = 'vague'").get();
  assert.equal(JSON.parse(vague.model_json).error, undefined);
  assert.deepEqual(JSON.parse(vague.workspace_json), { kind: 'scratch' });
});

test('a machine pinned to one folder clears its published projects', async () => {
  const { env, sqlite } = bindings();
  env.TYPESAFE_API_KEY = 'jev-test';
  const token = device(sqlite);
  await call(env, token, 'projects', { projects: PROJECTS });
  await call(env, token, 'projects', { projects: [] });
  const seen = [];
  await inbound(env, 'pinned', 'In TagMails, fix the footer.', [], jev('p_0000000001', seen));
  assert.equal(seen.filter((request) => request.questions.folder).length, 0);
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
  assert.equal(explicitWorkspace('See /Users/me/Downloads/shot.png and fix TagMails.', projects), null);
});

test('routing uses the explicit path without calling Jev', async () => {
  const projects = cleanProjectCatalog(PROJECTS);
  const fail = async () => { throw new Error('Jev should not be called'); };
  assert.deepEqual(await routeProject('Work in /Users/me/code/pupcal.', projects, { apiKey: 'k', fetcher: fail }),
    { kind: 'project', id: 'p_0000000002', name: 'PupCal', path: '/Users/me/code/pupcal' });
  assert.match((await routeProject('Work in /tmp/elsewhere and fix it.', projects, { apiKey: 'k', fetcher: fail })).ask, /Which project/);
});
