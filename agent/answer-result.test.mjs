import assert from 'node:assert/strict';
import test from 'node:test';
import { attachmentsFrom, formatAgentAnswer } from './answer-result.mjs';

test('a long first paragraph continues in email details without splitting words', () => {
  const words = Array.from({ length: 100 }, (_, index) => `item${index}`);
  const answer = words.join(' ');
  const result = formatAgentAnswer(answer);
  assert.equal(result.truncated, false);
  assert.ok(result.summary.length <= 500);
  assert.ok(result.details.every((detail) => detail.length <= 300));
  assert.deepEqual([result.summary, ...result.details].join(' ').split(' '), words);
});

test('email answer truncation is explicit when the result contract is full', () => {
  const result = formatAgentAnswer(Array.from({ length: 2000 }, (_, index) => `word${index}`).join(' '));
  assert.equal(result.details.length, 12);
  assert.equal(result.truncated, true);
  assert.ok(result.details.every((detail) => detail.length <= 300));
});

test('the first short paragraph remains the summary', () => {
  assert.deepEqual(formatAgentAnswer('Done.\n\nChecked the source.\n\nOne caveat.'), {
    summary: 'Done.', details: ['Checked the source.', 'One caveat.'], truncated: false,
    answer: 'Done.\n\nChecked the source.\n\nOne caveat.', answerTruncated: false,
  });
});

test('the agent names files to attach and those lines leave the email', () => {
  const answer = 'The four scripts are ready.\n\nTagMails-Attach: scripts/madrid.docx\n`TagMails-Attach: scripts/paris.docx`\nTagMails-Attach: scripts/madrid.docx\n';
  const formatted = formatAgentAnswer(answer);
  assert.equal(formatted.answer, 'The four scripts are ready.');
  assert.deepEqual(formatted.attach, ['scripts/madrid.docx', 'scripts/paris.docx']);
  assert.equal(formatAgentAnswer('No files here.').attach, undefined);
  assert.equal(attachmentsFrom(Array.from({ length: 8 }, (_, i) => `TagMails-Attach: f${i}.md`).join('\n')).paths.length, 5);
});

test('local file links become code names, web links stay', () => {
  const formatted = formatAgentAnswer('Edited [layouts.mjs](/Users/me/p/lib/layouts.mjs), [`server.mjs`](file:///Users/me/p/server.mjs:12) and [docs](https://example.com/docs).');
  assert.equal(formatted.answer, 'Edited `layouts.mjs`, `server.mjs` and [docs](https://example.com/docs).');
});
