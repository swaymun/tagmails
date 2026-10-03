import assert from 'node:assert/strict';
import test from 'node:test';
import { chooseModel } from './model.mjs';

test('only the leading directive block selects a model', () => {
  assert.deepEqual(chooseModel('Model: Claude\nReview this.'),
    { id: 'claude-sonnet-5-5', effort: 'medium', source: 'explicit' });
  assert.deepEqual(chooseModel('TagMails-File: report.txt\nModel: Luna\nCreate the report.'),
    { id: 'gpt-6-luna', effort: 'low', source: 'explicit' });
  assert.deepEqual(chooseModel('Model: Claude Sonnet 5.5 medium\n\nContinue the thread.'),
    { id: 'claude-sonnet-5-5', effort: 'medium', source: 'explicit' });
  assert.deepEqual(chooseModel('Model: Codex 6.1 Sol medium\n\nContinue the thread.'),
    { id: 'gpt-6.1-sol', effort: 'medium', source: 'explicit' });
  assert.deepEqual(chooseModel('Please review this.\n\nOn Friday, Alex wrote:\nModel: Luna', 'claude-sonnet-5-5'),
    { id: 'claude-sonnet-5-5', effort: 'medium', source: 'default' });
  assert.deepEqual(chooseModel('> Model: Luna\n> Old request', 'claude-sonnet-5-5'),
    { id: 'claude-sonnet-5-5', effort: 'medium', source: 'default' });
  assert.equal(chooseModel('Model:\nReview this.').error,
    'Choose Codex, Claude, or Luna after Model:.');
});
