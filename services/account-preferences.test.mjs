import assert from 'node:assert/strict';
import test from 'node:test';
import { bindings } from './bindings-fixture.mjs';
import { accountPreferences, saveAccountPreferences } from './account-preferences.mjs';
import { routeModel as routeModelWith } from '../agent/routing-model.mjs';
// The classifier is injected as `ask`; these tests drive it with canned answers.
const route = routeModelWith;
const routeModel = (body, defaultModel, { apiKey, fetcher, ...rest } = {}) => route(body, defaultModel, { ...rest,
  ask: fetcher && (async (request) => (await (await fetcher('https://classifier.test', { method: 'POST', body: JSON.stringify(request) })).json()).answers) });


test('email defaults persist and supply a fallback while the Mac may override task choices', async () => {
  const { env } = bindings();
  const account = { id: 'account-1', default_model: 'gpt-6.1-sol' };
  assert.deepEqual(await accountPreferences(env, account), {
    model: 'gpt-6.1-sol', effort: 'medium', speed: 'standard', source: 'default',
  });
  await saveAccountPreferences(env, account, { model: 'gpt-6-luna', effort: 'high', speed: 'fast' });
  const saved = await accountPreferences(env, account);
  assert.deepEqual(saved, { model: 'gpt-6-luna', effort: 'high', speed: 'fast', source: 'site' });
  assert.deepEqual(await routeModel('Review the files.', saved.model, {
    defaultEffort: saved.effort, defaultSpeed: saved.speed,
  }), { id: 'gpt-6-luna', effort: 'high', speed: 'fast', source: 'default' });
  const explicitStandard = await routeModel('Use standard speed for this task.', saved.model, {
    defaultEffort: saved.effort, defaultSpeed: saved.speed, apiKey: 'test',
    fetcher: async () => Response.json({ answers: {
      speed: { type: 'choice', choice: 'standard', probabilities: { standard: 0.96 } },
    } }),
  });
  assert.deepEqual(explicitStandard, { id: 'gpt-6-luna', effort: 'high', source: 'default' });
  await assert.rejects(saveAccountPreferences(env, account, {
    model: 'claude-sonnet-5-5', effort: 'medium', speed: 'fast',
  }), /does not offer this speed/);
  await assert.rejects(saveAccountPreferences(env, account, {
    model: 'gpt-6-luna', effort: 'ultra', speed: 'standard',
  }), /does not offer Ultra reasoning/);
});
