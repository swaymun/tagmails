import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classify, classifierPrompt, parseAnswer, routeClaim, routeFollowUpLocally } from './local-router.mjs';

const efforts = ['low', 'medium', 'high'].map((reasoningEffort) => ({ reasoningEffort }));
const catalog = { models: [
  { id: 'gpt-6-sol', name: 'GPT-6 Sol', supportedReasoningEfforts: efforts, serviceTiers: [] },
  { id: 'gpt-6-luna', name: 'GPT-6 Luna', supportedReasoningEfforts: efforts, serviceTiers: [] },
], claudeModels: [] };
const projects = [
  { id: 'p_a100000001', name: 'TagMails', path: '/Users/me/tagmails', aliases: [], description: 'Email relay. '.repeat(40), branch: 'main' },
  { id: 'p_a100000002', name: 'PupCal', path: '/Users/me/pupcal', aliases: [], description: 'Pet calendars.', branch: null },
];
const owner = (body, extra = {}) => ({ threadId: 'thread-1', model: { id: 'gpt-6-sol', effort: 'medium', source: 'default' },
  request: { fromOwner: true, subject: 'Footer', body }, ...extra });

// A classifier that answers each question by name; `model1` is Luna in this catalog.
const answering = (choices, seen = []) => async (request) => {
  seen.push(request);
  const answers = {};
  for (const name of Object.keys(request.questions)) {
    const choice = choices[name];
    if (choice) answers[name] = { type: 'choice', choice, probabilities: { [choice]: 1 } };
  }
  return { answers, runner: 'claude', ms: 7 };
};
const quiet = (work) => async (...args) => { const log = console.log; console.log = () => {}; try { return await work(...args); } finally { console.log = log; } };

test('an owner email is routed to the model it asks for and the folder it means', quiet(async () => {
  const seen = [];
  const out = await routeClaim({ claim: owner('Use Luna to fix the footer in TagMails.'), catalog, projects,
    classifyWith: answering({ route: 'model1', requestedEffort: 'unrequested', effort: 'low', speed: 'none', folder: 'p_a100000001' }, seen) });
  assert.deepEqual(out.model, { id: 'gpt-6-luna', effort: 'low', source: 'classified' });
  assert.deepEqual(out.workspace, { kind: 'project', id: 'p_a100000001', name: 'TagMails', path: '/Users/me/tagmails' });
  // The model and the folder are separate questions, so they classify at the same time.
  assert.deepEqual(seen.map((request) => Object.keys(request.questions)).sort(), [['folder'], ['route', 'requestedEffort', 'effort', 'speed']].sort());
  // Descriptions are cut to one line, so the folder prompt stays short.
  assert.ok(Object.values(seen.find((request) => request.questions.folder).questions.folder.criteria)
    .filter((entry) => entry.description).every((entry) => entry.description.length <= 160));
}));

test('an unavailable model is answered, not substituted', quiet(async () => {
  const out = await routeClaim({ claim: owner('Use Gemini for this.'), catalog, projects,
    classifyWith: answering({ route: 'unsupported', folder: 'ad_hoc' }) });
  assert.match(out.model.error, /unavailable/);
}));

test('an unclear folder asks once, and the reply is routed with the question it answers', quiet(async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'router-test-'));
  const none = { route: 'none', requestedEffort: 'unrequested', effort: 'medium', speed: 'none' };
  // Only the explicit-path rule can ask on its own: a path this Mac does not have.
  const ask = await routeClaim({ claim: owner('Work in /Users/me/missing and fix the footer.'), catalog, projects, dataDir,
    classifyWith: answering(none) });
  assert.match(ask.ask, /Which project/);
  assert.equal(ask.model, undefined);
  assert.match(await fs.readFile(path.join(dataDir, 'routing-pending.json'), 'utf8'), /thread-1/);
  const seen = [];
  const reply = await routeClaim({ claim: owner('TagMails'), catalog, projects, dataDir,
    classifyWith: answering({ ...none, folder: 'p_a100000001' }, seen) });
  assert.equal(reply.workspace.path, '/Users/me/tagmails');
  assert.match(seen.find((request) => request.questions.folder).state, /Work in \/Users\/me\/missing[\s\S]*The sender replied:\nTagMails/);
  assert.equal(JSON.parse(await fs.readFile(path.join(dataDir, 'routing-pending.json'), 'utf8'))['thread-1'], undefined, 'asked once');
}));

test('a participant and a thread that has its folder are not re-routed; an explicit Model line still routes the folder', quiet(async () => {
  const never = async () => { throw new Error('must not classify'); };
  assert.deepEqual(await routeClaim({ claim: owner('Use Luna', { request: { fromOwner: false, subject: 'x', body: 'Use Luna' } }), catalog, projects, classifyWith: never }), {});
  // `Model: Luna` settles the model only; which project is still the Mac's to choose.
  const explicit = [];
  const picked = await routeClaim({ claim: owner('Model: Luna\nFix the footer in TagMails.', { model: { id: 'gpt-6-luna', effort: 'medium', source: 'explicit' } }), catalog, projects,
    classifyWith: answering({ folder: 'p_a100000001' }, explicit) });
  assert.equal(picked.workspace.path, '/Users/me/tagmails');
  assert.deepEqual(explicit.map((request) => Object.keys(request.questions)), [['folder']], 'no model question is asked');
  const seen = [];
  const out = await routeClaim({ claim: owner('Fix it.', { workspace: { kind: 'project', path: '/Users/me/tagmails' } }), catalog, projects,
    classifyWith: answering({ route: 'none', requestedEffort: 'unrequested', effort: 'medium', speed: 'none' }, seen) });
  assert.equal(out.workspace, undefined);
  assert.equal(seen.some((request) => request.questions.folder), false);
}));

test('when no CLI can classify, the job runs with the relay defaults', quiet(async () => {
  const original = console.error; console.error = () => {};
  try {
    const out = await routeClaim({ claim: owner('Use Luna on TagMails.'), catalog, projects,
      classifyWith: async () => { throw new Error('routing unavailable'); } });
    assert.equal(out.workspace, undefined);
    assert.equal(out.model, undefined);
    assert.equal(out.failures.length, 2, "model and folder each failed");
  } finally { console.error = original; }
}));

test('follow-ups are steer, queue or ack, and queue when the classifier fails', async () => {
  const steer = (choice) => async (request) => ({ answers: { route: { type: 'choice', choice, probabilities: { [choice]: 1 } } }, runner: 'codex', ms: 3, request });
  assert.equal((await routeFollowUpLocally({ running: 'Write the guide', followUp: 'make it 10 days', classifyWith: steer('steer') })).choice, 'steer');
  assert.equal((await routeFollowUpLocally({ running: 'Write the guide', followUp: 'thanks!', classifyWith: steer('ack') })).choice, 'ack');
  assert.equal((await routeFollowUpLocally({ running: 'Write the guide', followUp: 'and the Korea guide', classifyWith: steer('queue') })).choice, 'queue');
  assert.equal((await routeFollowUpLocally({ running: 'x', followUp: 'y', classifyWith: async () => { throw new Error('down'); } })).choice, 'queue');
});

test('the CLI is asked for JSON only, falls back to the other CLI, and answers outside the choices are ignored', async () => {
  const request = { state: 'Subject: Hi', questions: { route: { type: 'choice', instructions: 'Pick.', criteria: { steer: 'a', queue: 'b' } } } };
  assert.match(classifierPrompt(request), /Rules:[\s\S]*Never substitute a supported model[\s\S]*Return one JSON object/);
  const calls = [];
  const ask = { claude: async () => { calls.push('claude'); throw new Error('not signed in'); },
    codex: async () => { calls.push('codex'); return 'Sure: {"route":"queue"}'; } };
  const result = await classify(request, 'claude', { ask });
  assert.deepEqual(calls, ['claude', 'codex']);
  assert.equal(result.runner, 'codex');
  assert.equal(result.answers.route.choice, 'queue');
  await assert.rejects(classify(request, 'codex', { ask: { codex: async () => '{"route":"nonsense"}', claude: async () => 'not json' } }), /routing unavailable/);
  assert.deepEqual(parseAnswer('x {"a":1} y'), { a: 1 });
});
