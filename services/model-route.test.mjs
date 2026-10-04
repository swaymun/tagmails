import assert from 'node:assert/strict';
import test from 'node:test';
import { selectedModelDetail, selectedModelStatus } from './model-route.mjs';

test('the receipt distinguishes a requested Fast tier from measured speed', () => {
  assert.equal(selectedModelDetail(JSON.stringify({ id: 'gpt-6-luna', effort: 'medium',
    speed: 'fast', source: 'classified' })),
  'Selected model: Codex GPT-6 Luna (medium; fast tier requested; requested in this email).');
});

test('the receipt names the available pilot Sol default', () => {
  assert.equal(selectedModelDetail(JSON.stringify({ id: 'gpt-6-sol', effort: 'medium', source: 'pilot' })),
    'Selected model: Codex GPT-6 Sol (medium; standard speed; available pilot default).');
});

test('the email footer keeps the selected route compact without claiming measured speed', () => {
  assert.equal(selectedModelStatus(JSON.stringify({ id: 'gpt-6-sol', effort: 'high',
    speed: 'fast', source: 'classified' })),
  'GPT-6 Sol · High · Fast');
});

test('the receipt names a newer model reported by the Mac', () => {
  assert.match(selectedModelDetail(JSON.stringify({ id: 'gpt-6-astra', effort: 'high',
    source: 'classified' })), /Codex GPT-6 Astra/);
});
