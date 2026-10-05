import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanClaudeModels, probeClaudeModels } from './claude-models.mjs';

test('Claude models come from the SDK list, without the "default" alias or duplicates', async () => {
  const rows = [
    { value: 'default', resolvedModel: 'claude-opus-5-5', displayName: 'Default', supportedEffortLevels: ['low'] },
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 5.5', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'], supportsFastMode: true, supportsAutoMode: true },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5-5', displayName: 'Sonnet 5.5', supportedEffortLevels: ['low', 'medium', 'bogus'] },
    { value: 'opus[1m]', resolvedModel: 'claude-opus-5-5', displayName: 'Opus 1M' },
    { value: 'weird', resolvedModel: 'gpt-6', displayName: 'Not Claude' },
  ];
  assert.deepEqual(cleanClaudeModels(rows), [
    { id: 'claude-opus-5-5', name: 'Opus 5.5', harness: 'claude', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], speeds: ['standard', 'fast'], autoMode: true },
    { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', harness: 'claude', efforts: ['low', 'medium'], speeds: ['standard'] },
  ]);
  let closed = false;
  const result = await probeClaudeModels({ load: async () => ({ query: () => ({
    supportedModels: async () => rows, close: () => { closed = true; } }) }) });
  assert.equal(result.models.length, 2);
  assert.equal(closed, true);
});
