import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { handleDeviceRequest } from './device-jobs.mjs';
import { accountModelCatalog, cleanCodexCatalog } from './model-catalog.mjs';
import { accountPreferences, clearAccountPreferences, saveAccountPreferences } from './account-preferences.mjs';
import { routeModel } from './jev-route.mjs';

const token = `tm_dev_${'a'.repeat(43)}`;
const reported = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra',
    supportedReasoningEfforts: ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort })),
    serviceTiers: [{ id: 'priority', name: 'Fast' }] },
  { id: 'gpt-6-sol', name: 'GPT-6 Sol',
    supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], serviceTiers: [] },
];

test('a paired Mac publishes a bounded model list that is scoped to its owner', async () => {
  const { env, sqlite } = bindings();
  sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)')
    .run('device-1', 'account-1', createHash('sha256').update(token).digest('hex'));
  const request = (models, bearer = token) => handleDeviceRequest(new Request('https://relay.test/api/device/models', {
    method: 'POST', headers: { Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ models }),
  }), env);
  assert.equal((await request(reported, 'wrong')).status, 401);
  assert.equal((await request([{ ...reported[0], id: 'claude-opus-4' }])).status, 400);
  assert.equal((await request(reported)).status, 200);
  const catalog = await accountModelCatalog(env.DB, 'account-1');
  assert.deepEqual(catalog.models.map((model) => model.id), ['gpt-6-astra', 'gpt-6-sol']);
  assert.deepEqual(catalog.models[0].speeds, ['standard', 'fast']);
  assert.deepEqual(catalog.models[1].speeds, ['standard']);
  assert.deepEqual((await accountModelCatalog(env.DB, 'other-account')).models, []);
  await assert.rejects(saveAccountPreferences(env, { id: 'account-1' }, {
    model: 'gpt-6-sol', effort: 'high', speed: 'standard',
  }), /does not offer/);
  assert.deepEqual(await saveAccountPreferences(env, { id: 'account-1' }, {
    model: 'gpt-6-astra', effort: 'high', speed: 'fast',
  }), { model: 'gpt-6-astra', effort: 'high', speed: 'fast', source: 'site' });
  sqlite.prepare("UPDATE devices SET revoked_at = CURRENT_TIMESTAMP WHERE id = 'device-1'").run();
  assert.deepEqual((await accountModelCatalog(env.DB, 'account-1')).models, []);
});

test('Jev chooses a model from the Mac catalog and rejects unsupported settings', async () => {
  const availableModels = cleanCodexCatalog(reported);
  const fetcher = async (_url, request) => {
    const criteria = JSON.parse(request.body).questions.route.criteria;
    assert.match(criteria.model0, /GPT-6 Astra/);
    assert.equal(criteria.codex61, undefined);
    return Response.json({ answers: { route: { type: 'choice', choice: 'model0',
      probabilities: { model0: 0.97 } } } });
  };
  assert.deepEqual(await routeModel('Use Astra for this.', 'gpt-6-sol', {
    availableModels, apiKey: 'test', fetcher,
  }), { id: 'gpt-6-astra', effort: 'medium', source: 'classified' });
  assert.deepEqual(await routeModel('Review this.', 'gpt-6.1-sol', {
    availableModels, pilotCodexModel: 'gpt-6-sol',
  }), { id: 'gpt-6-sol', effort: 'medium', source: 'default' });
  const unsupported = await routeModel('Model: GPT-6 Sol ultra\nReview this.', 'gpt-6-astra', {
    availableModels,
  });
  assert.match(unsupported.error, /does not offer ultra reasoning/);
});

test('a machine can publish Codex and Claude models together, or either alone', async () => {
  const { catalogFromDevice } = await import('./model-catalog.mjs');
  const codex = [{ id: 'gpt-6-sol', name: 'GPT-6 Sol', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], serviceTiers: [] }];
  const claude = [{ id: 'claude-opus-5-5', name: 'Opus 5.5', efforts: ['low', 'medium', 'max'], speeds: ['standard', 'fast'] }];
  const both = catalogFromDevice({ models: codex, claudeModels: claude });
  assert.deepEqual(both.map((model) => [model.id, model.harness]), [['gpt-6-sol', 'codex'], ['claude-opus-5-5', 'claude']]);
  assert.deepEqual(catalogFromDevice({ claudeModels: claude }).map((model) => model.id), ['claude-opus-5-5']);
  assert.throws(() => catalogFromDevice({}));
  assert.throws(() => catalogFromDevice({ claudeModels: [{ ...claude[0], id: 'gpt-6-sol' }] }));
  assert.throws(() => catalogFromDevice({ claudeModels: [{ ...claude[0], efforts: ['ultra'] }] }));
});

test('"use Claude" routes to the machine\'s Claude model', async () => {
  const { routeModel } = await import('./jev-route.mjs');
  const availableModels = [
    { id: 'gpt-6-sol', name: 'GPT-6 Sol', efforts: ['low', 'medium', 'high'], speeds: ['standard'] },
    { id: 'claude-opus-5-5', name: 'Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], speeds: ['standard', 'fast'] },
  ];
  const jev = async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.match(body.questions.route.criteria.model1, /Opus 5\.5 \(claude-opus-5-5\)/);
    return Response.json({ answers: { route: { type: 'choice', choice: 'claude', probabilities: { claude: 0.9 } },
      requestedEffort: { type: 'choice', choice: 'max', probabilities: { max: 0.9 } } } });
  };
  assert.deepEqual(await routeModel('Use Claude at max effort to review this.', 'gpt-6-sol', { apiKey: 'k', fetcher: jev, availableModels }),
    { id: 'claude-opus-5-5', effort: 'max', source: 'classified' });
});

test('a site default overrides the computer default, which overrides the account model', async () => {
  const { env, sqlite } = bindings();
  sqlite.prepare('INSERT INTO devices (id, account_id, token_hash) VALUES (?, ?, ?)')
    .run('device-1', 'account-1', createHash('sha256').update(token).digest('hex'));
  const publish = (defaults) => handleDeviceRequest(new Request('https://relay.test/api/device/models', {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ models: reported, defaults }),
  }), env);
  const account = { id: 'account-1', default_model: 'gpt-6-sol' };
  assert.equal((await publish({ model: 'gpt-6-astra', effort: 'xhigh', speed: 'fast' })).status, 200);
  // An effort the model lacks is dropped rather than trusted.
  assert.deepEqual(await accountPreferences(env, account),
    { model: 'gpt-6-astra', effort: 'medium', speed: 'fast', source: 'computer' });
  await publish({ model: 'gpt-6-astra', effort: 'high' });
  assert.equal((await accountPreferences(env, account)).effort, 'high');
  await saveAccountPreferences(env, account, { model: 'gpt-6-sol', effort: 'medium', speed: 'standard' });
  assert.deepEqual(await accountPreferences(env, account),
    { model: 'gpt-6-sol', effort: 'medium', speed: 'standard', source: 'site' });
  assert.equal((await clearAccountPreferences(env, account)).source, 'computer');
  await publish({ model: 'not-on-this-mac' });
  assert.equal((await accountPreferences(env, account)).source, 'default');
});
