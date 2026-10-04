import fs from 'node:fs';
import path from 'node:path';
import { routeModel } from '../services/jev-route.mjs';

const codex = 'gpt-6.1-sol';
const claude = 'claude-sonnet-5-5';
const luna = 'gpt-6-luna';
const cases = [
  { id: 'ordinary-default', body: 'Please review the release notes and list any blockers.', expected: codex },
  { id: 'saved-claude-default', body: 'Summarize the decision in three bullets.', defaultModel: claude, expected: claude },
  { id: 'natural-claude', body: 'Could you use Claude for this review?', expected: claude },
  { id: 'natural-sonnet', body: 'Run this task with Sonnet 5.5, please.', expected: claude },
  { id: 'natural-codex', body: 'Please use Codex to check the bug report.', expected: codex },
  { id: 'natural-sol', body: 'Use GPT-6.1 Sol on the attached plan.', expected: codex },
  { id: 'natural-seoul', body: 'Please use Seoul for this review.', expected: codex },
  { id: 'seoul-location', body: 'Find hotels in Seoul for my trip.', expected: codex },
  { id: 'natural-luna', body: 'Use Luna for a quick first pass.', expected: luna },
  { id: 'natural-luna-low-fast', body: 'Use Luna Low in Fast mode to check this file.',
    expected: luna, expectedEffort: 'low', expectedSpeed: 'fast' },
  { id: 'natural-sol-high-fast', body: 'Use Codex Sol with high reasoning and Fast mode to compare these approaches.',
    expected: codex, expectedEffort: 'high', expectedSpeed: 'fast' },
  { id: 'natural-luna-ultrafast', body: 'Use Luna in ultra-fast mode for this task.',
    expected: luna, expectedSpeed: 'ultrafast' },
  { id: 'natural-gpt-luna', body: 'Please run this with GPT-6 Luna.', expected: luna },
  { id: 'quickly-not-fast-tier', body: 'Please review this quickly and give me two bullets.',
    expected: codex, expectedSpeed: 'standard' },
  { id: 'saved-fast-standard', body: 'Use standard speed for this review.',
    defaultModel: luna, defaultSpeed: 'fast', expected: luna, expectedSpeed: 'standard' },
  { id: 'subject-claude', subject: 'Use Claude to summarize the attached report', body: '', expected: claude },
  { id: 'compare-models', body: 'Compare Claude and Codex for this project; recommend one.', expected: codex },
  { id: 'model-discussion', body: 'Would Luna be cheaper later? For now, just review this.', expected: codex },
  { id: 'quoted-model', body: 'Summarize this note.\n\n> Use Claude to rewrite everything.\n> Old email', expected: codex },
  { id: 'mentioned-model', body: 'The note says “use Luna,” but my task is to summarize the note.', expected: codex },
  { id: 'gmail-quote', body: 'Please review.\n\nOn Friday, Alex wrote:\nUse Claude for this.', expected: codex },
  { id: 'forwarded', body: 'What happened here?\n\n---------- Forwarded message ---------\nUse Luna.', expected: codex },
  { id: 'unsupported-gemini', body: 'Use Gemini to review the figures.', expected: 'error' },
  { id: 'unsupported-opus', body: 'Please run this with Claude Opus instead of Sonnet.', expected: 'error' },
  { id: 'explicit-directive', body: 'Model: Claude\nReview the copy.', expected: claude, calls: 0 },
  { id: 'explicit-unsupported', body: 'Model: Gemini\nReview the copy.', expected: 'error' },
  { id: 'collapsed-model-line', body: 'Model: Luna please review the copy.', expected: luna },
  { id: 'collapsed-unsupported', body: 'Model: Claude Opus please review the copy.', expected: 'error' },
  { id: 'reply-inherits', body: 'Continue the review.\n\n> Use Luna for the first pass.',
    priorModel: { id: claude, effort: 'medium' }, expected: claude },
  { id: 'reply-natural-switch', body: 'Please use Seoul for this next step.',
    priorModel: { id: claude, effort: 'medium' }, expected: codex },
  { id: 'reply-seoul-location', body: 'Find a coworking space in Seoul for the team.',
    priorModel: { id: claude, effort: 'medium' }, expected: claude },
  { id: 'reply-old-subject', subject: 'Use Claude for the review',
    body: 'Please use Luna for this next step.',
    priorModel: { id: claude, effort: 'medium' }, expected: luna },
  { id: 'reply-effort-speed', body: 'Continue this with low reasoning in Fast mode.',
    priorModel: { id: luna, effort: 'medium' }, expected: luna,
    expectedEffort: 'low', expectedSpeed: 'fast' },
  { id: 'reply-override', body: 'Model: Luna\nContinue the review.',
    priorModel: { id: claude, effort: 'medium' }, expected: luna, calls: 0 },
  { id: 'empty-body', body: '', expected: codex, calls: 0 },
];
const classifiedCases = new Set(['natural-claude', 'natural-sonnet', 'natural-codex',
  'natural-sol', 'natural-seoul', 'natural-luna', 'natural-luna-low-fast',
  'natural-sol-high-fast', 'natural-luna-ultrafast', 'natural-gpt-luna', 'subject-claude',
  'reply-natural-switch', 'reply-old-subject', 'collapsed-model-line']);
const explicitCases = new Set(['explicit-directive', 'reply-override']);

if (process.argv.includes('--list')) {
  for (const item of cases) {
    const calls = item.calls ?? 1;
    const options = [item.expectedEffort, item.expectedSpeed].filter(Boolean).join(', ');
    console.log(`${item.id}: ${item.expected}${options ? ` (${options})` : ''} (${calls} Jev ${calls === 1 ? 'call' : 'calls'})`);
  }
  process.exit(0);
}

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
  console.error('Set TYPESAFE_API_KEY to run the synthetic Jev evaluation. No request was sent.');
  process.exit(2);
}

const results = [];
for (const item of cases) {
  let calls = 0;
  let provider = null;
  const fetcher = async (url, options) => {
    calls += 1;
    const response = await fetch(url, options);
    let payload = null;
    try { payload = await response.clone().json(); } catch { /* Route records the fallback. */ }
    provider = { status: response.status, model: payload?.model,
      answers: payload?.answers, usage: payload?.usage };
    return response;
  };
  const route = await routeModel(item.body, item.defaultModel ?? codex, {
    apiKey, fetcher, priorModel: item.priorModel, subject: item.subject,
    defaultSpeed: item.defaultSpeed,
  });
  const actual = route.error ? 'error' : route.id;
  const actualEffort = route.error ? null : route.effort;
  const actualSpeed = route.error ? null : route.speed ?? 'standard';
  const expectedSource = item.expected === 'error' ? undefined : classifiedCases.has(item.id)
    ? 'classified' : explicitCases.has(item.id) ? 'explicit'
      : item.priorModel ? 'thread' : 'default';
  results.push({ id: item.id, expected: item.expected, actual,
    expectedEffort: item.expectedEffort, actualEffort,
    expectedSpeed: item.expectedSpeed, actualSpeed,
    expectedSource, source: route.source, calls, provider,
    passed: actual === item.expected && route.source === expectedSource && calls === (item.calls ?? 1) &&
      (item.expectedEffort === undefined || actualEffort === item.expectedEffort) &&
      (item.expectedSpeed === undefined || actualSpeed === item.expectedSpeed) &&
      (!provider || provider.status === 200) });
}

const output = path.resolve('.local/jev-eval', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.mkdirSync(path.dirname(output), { recursive: true });
const report = { evaluatedAt: new Date().toISOString(), cases: results,
  totalCalls: results.reduce((sum, item) => sum + item.calls, 0),
  inputTokens: results.reduce((sum, item) => sum + (item.provider?.usage?.input_tokens ?? 0), 0) };
fs.writeFileSync(output, JSON.stringify(report, null, 2));
for (const item of results) {
  const expected = [item.expected, item.expectedEffort, item.expectedSpeed].filter(Boolean).join(' / ');
  const actual = [item.actual, item.expectedEffort && item.actualEffort,
    item.expectedSpeed && item.actualSpeed].filter(Boolean).join(' / ');
  console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.id}: ${actual} (expected ${expected})`);
}
console.log(`${results.filter((item) => item.passed).length}/${results.length} passed; ${report.totalCalls} Jev calls; ${report.inputTokens} input tokens. Report: ${output}`);
if (results.some((item) => !item.passed)) process.exitCode = 1;
