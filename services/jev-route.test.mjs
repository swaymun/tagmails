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
  }), { error: 'That model is unavailable for this agent. Ask for an available OpenAI or Claude model, or omit the model to use your default.' });
  assert.deepEqual(await routeModel('Use Claude Opus for this review.', 'gpt-6.1-sol', {
    apiKey: 'test-key', fetcher: jev('unsupported', 0.67),
  }), { error: 'That model is unavailable for this agent. Ask for an available OpenAI or Claude model, or omit the model to use your default.' });
});

test('an exact directive stays authoritative without a Jev call', async () => {
  let calls = 0;
  assert.deepEqual(await routeModel('Model: Luna\nDo this.', 'gpt-6.1-sol', {
    apiKey: 'test-key', fetcher: async (...args) => {
      calls += 1;
      return jev('codex', 0.97)(...args);
    },
  }), { id: 'gpt-6-luna', effort: 'medium', source: 'explicit' });
  assert.equal(calls, 0);
});

test('private pilot uses available Sol without silently replacing an exact 6.1 request', async () => {
  const pilot = { pilotCodexModel: 'gpt-6-sol' };
  assert.deepEqual(await routeModel('Review this file.', 'gpt-6.1-sol', pilot),
    { id: 'gpt-6-sol', effort: 'medium', source: 'pilot' });
  assert.deepEqual(await routeModel('Use Sol for this review.', 'gpt-6.1-sol', {
    ...pilot, apiKey: 'test-key', fetcher: jev('codex', 0.96),
  }), { id: 'gpt-6-sol', effort: 'medium', source: 'classified' });
  assert.deepEqual(await routeModel('Use GPT-6.1 Sol for this review.', 'gpt-6.1-sol', {
    ...pilot, apiKey: 'test-key', fetcher: jev('codex61', 0.96),
  }), { id: 'gpt-6.1-sol', effort: 'medium', source: 'classified' });
  assert.deepEqual(await routeModel('Model: GPT-6.1 Sol\nReview this.', 'gpt-6.1-sol', pilot),
    { id: 'gpt-6.1-sol', effort: 'medium', source: 'explicit' });
  assert.deepEqual(await routeModel('Model: Codex\nReview this.', 'gpt-6.1-sol', pilot),
    { id: 'gpt-6-sol', effort: 'medium', source: 'explicit' });
  assert.deepEqual(await routeModel('Continue the review.', 'gpt-6.1-sol', {
    ...pilot, priorModel: { id: 'gpt-6-sol', effort: 'high' },
    apiKey: 'test-key', fetcher: jev('none', 0.97),
  }), { id: 'gpt-6-sol', effort: 'high', source: 'thread' });
});

test('a collapsed leading Model line is classified or clarified without running another model', async () => {
  assert.deepEqual(await routeModel('Model: Luna please review this.', 'gpt-6.1-sol', {
    apiKey: 'test-key', fetcher: jev('luna', 0.94),
  }), { id: 'gpt-6-luna', effort: 'medium', source: 'classified' });
  const uncertain = await routeModel('Model: Luna please review this.', 'gpt-6.1-sol', {
    apiKey: 'test-key', fetcher: jev('luna', 0.42),
  });
  assert.match(uncertain.error, /could not identify an available OpenAI or Claude model/);
  const unsupported = await routeModel('Model: Gemini\nReview the copy.', 'gpt-6.1-sol', {
    apiKey: 'test-key', fetcher: jev('none', 0.71),
  });
  assert.match(unsupported.error, /could not identify an available OpenAI or Claude model/);
  const lowConfidenceUnsupported = await routeModel('Model: Claude Opus please review this.',
    'gpt-6.1-sol', { apiKey: 'test-key', fetcher: jev('unsupported', 0.63) });
  assert.match(lowConfidenceUnsupported.error, /model is unavailable/);
  assert.deepEqual(await routeModel('Model: Claude Opus please review this.', 'gpt-6.1-sol', {
    apiKey: 'test-key', fetcher: jev('unsupported', 0.95),
  }), { error: 'That model is unavailable for this agent. Ask for an available OpenAI or Claude model, or omit the model to use your default.' });
  assert.deepEqual(await routeModel('Model: Claude Internal routing check. Review this.',
    'gpt-6.1-sol', { apiKey: 'test-key', fetcher: jev('claude', 0.92) }),
  { id: 'claude-sonnet-5-5', effort: 'medium', source: 'classified' });
});

test('natural requests can change a reply model; ordinary replies inherit it', async () => {
  const priorModel = { id: 'claude-sonnet-5-5', effort: 'medium', source: 'classified' };
  assert.deepEqual(await routeModel('Please use Seoul for this next step.', 'gpt-6.1-sol', {
    subject: 'Use Claude for the review', priorModel, apiKey: 'test-key',
    fetcher: async (_url, request) => {
      assert.equal(JSON.parse(request.body).state, 'Please use Seoul for this next step.');
      return jev('codex', 0.94)(_url, request);
    },
  }), { id: 'gpt-6.1-sol', effort: 'medium', source: 'classified' });
  assert.deepEqual(await routeModel('Continue the review.\n\n> Use Luna for the first pass.',
    'gpt-6.1-sol', { priorModel, apiKey: 'test-key', fetcher: jev('none', 0.96) }),
  { id: 'claude-sonnet-5-5', effort: 'medium', source: 'thread' });
  assert.deepEqual(await routeModel('Continue the review.', 'gpt-6.1-sol', {
    priorModel, apiKey: 'test-key', fetcher: jev('codex', 0.52),
  }), { id: 'claude-sonnet-5-5', effort: 'medium', source: 'thread' });
});

test('Jev failure falls back to the saved default', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.deepEqual(await routeModel('Please review this.', 'claude-sonnet-5-5', {
      apiKey: 'test-key', fetcher: async () => { throw new Error('offline'); },
    }), { id: 'claude-sonnet-5-5', effort: 'medium', source: 'default' });
    assert.deepEqual(await routeModel('Continue this.', 'gpt-6.1-sol', {
      priorModel: { id: 'claude-sonnet-5-5', effort: 'medium' },
      apiKey: 'test-key', fetcher: async () => { throw new Error('offline'); },
    }), { id: 'claude-sonnet-5-5', effort: 'medium', source: 'thread' });
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

test('one Jev request interprets natural model, effort, and speed choices', async () => {
  let calls = 0;
  const selected = await routeModel('Use Luna Low in fast mode to check the file.', 'gpt-6.1-sol', {
    apiKey: 'test-key', fetcher: async (_url, request) => {
      calls += 1;
      const questions = JSON.parse(request.body).questions;
      assert.deepEqual(Object.keys(questions), ['route', 'requestedEffort', 'effort', 'speed']);
      return Response.json({ answers: Object.fromEntries([
        ['route', 'luna', 0.96], ['requestedEffort', 'low', 0.94],
        ['effort', 'medium', 0.91], ['speed', 'fast', 0.91],
      ].map(([key, choice, probability]) => [key, { type: 'choice', choice,
        probabilities: { [choice]: probability } }])) });
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(selected, { id: 'gpt-6-luna', effort: 'low', speed: 'fast', source: 'classified' });
});

test('an explicit high reasoning request wins over an ordinary complexity estimate', async () => {
  const selected = await routeModel('Use Codex Sol with high reasoning and Fast mode.',
    'gpt-6.1-sol', { apiKey: 'test-key', pilotCodexModel: 'gpt-6-sol',
      fetcher: async () => Response.json({ answers: {
        route: { type: 'choice', choice: 'codex', probabilities: { codex: 0.95 } },
        requestedEffort: { type: 'choice', choice: 'high', probabilities: { high: 0.65 } },
        effort: { type: 'choice', choice: 'medium', probabilities: { medium: 0.88 } },
        speed: { type: 'choice', choice: 'fast', probabilities: { fast: 0.93 } },
      } }),
    });
  assert.deepEqual(selected, { id: 'gpt-6-sol', effort: 'high', speed: 'fast', source: 'classified' });
});

test('uncertain effort uses medium and an explicit ultra-fast request reaches runtime validation', async () => {
  const selected = await routeModel('Use Luna medium at ultra-fast speed.', 'gpt-6.1-sol', {
    apiKey: 'test-key', fetcher: async () => Response.json({ answers: {
      route: { type: 'choice', choice: 'luna', probabilities: { luna: 0.94 } },
      effort: { type: 'choice', choice: 'low', probabilities: { low: 0.52 } },
      speed: { type: 'choice', choice: 'ultrafast', probabilities: { ultrafast: 0.94 } },
    } }),
  });
  assert.deepEqual(selected, { id: 'gpt-6-luna', effort: 'medium', speed: 'ultrafast', source: 'classified' });
});
