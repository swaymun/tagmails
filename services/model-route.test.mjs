import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedModelDetail } from './model-route.mjs';

test('the receipt distinguishes a requested Fast tier from measured speed', () => {
  assert.equal(selectedModelDetail(JSON.stringify({ id: 'gpt-6-luna', effort: 'medium',
    speed: 'fast', source: 'classified' })),
  'Selected model: Codex GPT-6 Luna (medium; fast tier requested; requested in this email).');
});

test('the receipt names the available pilot Sol default', () => {
  assert.equal(selectedModelDetail(JSON.stringify({ id: 'gpt-6-sol', effort: 'medium', source: 'pilot' })),
    'Selected model: Codex GPT-6 Sol (medium; standard speed; available pilot default).');
});
