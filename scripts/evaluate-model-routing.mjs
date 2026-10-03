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
  { id: 'natural-luna', body: 'Use Luna for a quick first pass.', expected: luna },
  { id: 'natural-gpt-luna', body: 'Please run this with GPT-6 Luna.', expected: luna },
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
  { id: 'explicit-unsupported', body: 'Model: Gemini\nReview the copy.', expected: 'error', calls: 0 },
  { id: 'reply-inherits', body: 'Continue the review.\n\n> Use Luna for the first pass.',
    priorModel: { id: claude, effort: 'medium' }, expected: claude, calls: 0 },
  { id: 'reply-override', body: 'Model: Luna\nContinue the review.',
    priorModel: { id: claude, effort: 'medium' }, expected: luna, calls: 0 },
  { id: 'empty-body', body: '', expected: codex, calls: 0 },
];
const classifiedCases = new Set(['natural-claude', 'natural-sonnet', 'natural-codex',
  'natural-sol', 'natural-luna', 'natural-gpt-luna', 'subject-claude']);
const explicitCases = new Set(['explicit-directive', 'reply-override']);

if (process.argv.includes('--list')) {
  for (const item of cases) {
    const calls = item.calls ?? 1;
    console.log(`${item.id}: ${item.expected} (${calls} Jev ${calls === 1 ? 'call' : 'calls'})`);
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
      answer: payload?.answers?.route, usage: payload?.usage };
    return response;
  };
  const route = await routeModel(item.body, item.defaultModel ?? codex, {
    apiKey, fetcher, priorModel: item.priorModel, subject: item.subject,
  });
  const actual = route.error ? 'error' : route.id;
  const expectedSource = item.expected === 'error' ? undefined : classifiedCases.has(item.id)
    ? 'classified' : explicitCases.has(item.id) ? 'explicit'
      : item.id === 'reply-inherits' ? 'thread' : 'default';
  results.push({ id: item.id, expected: item.expected, actual,
    expectedSource, source: route.source, calls, provider,
    passed: actual === item.expected && route.source === expectedSource && calls === (item.calls ?? 1) &&
      (!provider || provider.status === 200) });
}

const output = path.resolve('.local/jev-eval', `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
fs.mkdirSync(path.dirname(output), { recursive: true });
const report = { evaluatedAt: new Date().toISOString(), cases: results,
  totalCalls: results.reduce((sum, item) => sum + item.calls, 0),
  inputTokens: results.reduce((sum, item) => sum + (item.provider?.usage?.input_tokens ?? 0), 0) };
fs.writeFileSync(output, JSON.stringify(report, null, 2));
for (const item of results) console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.id}: ${item.actual} (expected ${item.expected})`);
console.log(`${results.filter((item) => item.passed).length}/${results.length} passed; ${report.totalCalls} Jev calls; ${report.inputTokens} input tokens. Report: ${output}`);
if (results.some((item) => !item.passed)) process.exitCode = 1;
