import assert from 'node:assert/strict';
import test from 'node:test';
import { formatAgentAnswer } from './answer-result.mjs';

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
