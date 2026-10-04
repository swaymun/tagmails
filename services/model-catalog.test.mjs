import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { handleDeviceRequest } from './device-jobs.mjs';
import { accountModelCatalog, cleanCodexCatalog } from './model-catalog.mjs';
import { saveAccountPreferences } from './account-preferences.mjs';
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
  }), { model: 'gpt-6-astra', effort: 'high', speed: 'fast' });
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
