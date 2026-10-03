import assert from 'node:assert/strict';
import test from 'node:test';
import { routeModel } from './jev-route.mjs';

function jev(choice, probability) {
  return async (_url, request) => {
    assert.equal(request.method, 'POST');
    assert.equal(JSON.parse(request.body).model, 'jev-1.13.0');
    return Response.json({ answers: { route: { type: 'choice', choice,
      probabilities: { [choice]: probability } } } });
  };
}

test('Jev routes a clear new-thread model request and defaults when uncertain', async () => {
  assert.deepEqual(await routeModel('Could you use Claude for this review?', 'gpt-6.1-sol', {
    apiKey: 'test-key', fetcher: jev('claude', 0.93),
  }), { id: 'claude-sonnet-5-5', effort: 'medium', source: 'classified' });
  assert.deepEqual(await routeModel('Compare Codex and Claude for me.', 'gpt-6.1-sol', {
    apiKey: 'test-key', fetcher: jev('claude', 0.54),
  }), { id: 'gpt-6.1-sol', effort: 'medium', source: 'default' });
  assert.deepEqual(await routeModel('Use Gemini for this review.', 'gpt-6.1-sol', {
    apiKey: 'test-key', fetcher: jev('unsupported', 0.97),
  }), { error: 'That model is not available. Use Codex, Claude, or Luna.' });
});

test('explicit directives and replies do not call Jev', async () => {
  const noCall = () => { throw new Error('Jev must not be called'); };
  assert.deepEqual(await routeModel('Model: Luna\nDo this.', 'gpt-6.1-sol', {
    apiKey: 'test-key', fetcher: noCall,
  }), { id: 'gpt-6-luna', effort: 'low', source: 'explicit' });
  assert.deepEqual(await routeModel('Continue this.', 'gpt-6.1-sol', {
    apiKey: 'test-key', fetcher: noCall,
    priorModel: { id: 'claude-sonnet-5-5', effort: 'medium', source: 'classified' },
  }), { id: 'claude-sonnet-5-5', effort: 'medium', source: 'thread' });
});

test('Jev failure falls back to the saved default', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await routeModel('Please review this.', 'claude-sonnet-5-5', {
      apiKey: 'test-key', fetcher: async () => { throw new Error('offline'); },
    }), { id: 'claude-sonnet-5-5', effort: 'medium', source: 'default' });
  } finally { console.error = originalError; }
});

test('Jev sees only the sender text before quoted mail', async () => {
  await routeModel('Please review.\n\nOn Friday, Alex wrote:\nUse Luna for this.\n> More old text',
    'gpt-6.1-sol', { apiKey: 'test-key', fetcher: async (_url, request) => {
      assert.equal(JSON.parse(request.body).state, 'Please review.\n');
      return Response.json({ answers: { route: { type: 'choice', choice: 'none',
        probabilities: { none: 0.97 } } } });
    } });
});

test('Jev considers a model request in the subject when the body is empty', async () => {
  assert.deepEqual(await routeModel('', 'gpt-6.1-sol', {
    subject: 'Use Claude to summarize the attached report', apiKey: 'test-key',
    fetcher: async (_url, request) => {
      assert.equal(JSON.parse(request.body).state,
        'Subject: Use Claude to summarize the attached report\nBody:\n');
      return Response.json({ answers: { route: { type: 'choice', choice: 'claude',
        probabilities: { claude: 0.95 } } } });
    },
  }), { id: 'claude-sonnet-5-5', effort: 'medium', source: 'classified' });
});
