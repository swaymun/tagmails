import assert from 'node:assert/strict';
import test from 'node:test';
import { addRunEvent, finishRunTranscript, runTranscript } from './run-transcript.mjs';

test('the linked transcript retains a long final answer beyond the email summary', () => {
  const answer = Array.from({ length: 700 }, (_, index) => `point${index}`).join(' ');
  assert.ok(answer.length > 5000 && answer.length < 8000);
  const transcript = finishRunTranscript(runTranscript({ body: 'Summarize the report.' }), answer);
  assert.equal(transcript.events.at(-1).text, answer);
  assert.equal(transcript.events.at(-1).phase, 'final_answer');
  assert.equal(transcript.truncated, false);
});

test('a streamed final answer is replaced with its longer result copy', () => {
  const answer = 'A'.repeat(2000);
  const transcript = runTranscript({ body: 'Explain the result.' });
  addRunEvent(transcript, 'assistant', answer);
  finishRunTranscript(transcript, answer);
  assert.deepEqual(transcript.events.map((event) => event.kind), ['request', 'assistant']);
  assert.equal(transcript.events.at(-1).text, answer);
  assert.equal(transcript.events.at(-1).phase, 'final_answer');
  assert.equal(transcript.truncated, false);
});

test('an exact streamed final answer is labeled as the final answer', () => {
  const transcript = runTranscript({ body: 'Explain the result.' });
  addRunEvent(transcript, 'assistant', 'The answer is 42.');
  finishRunTranscript(transcript, 'The answer is 42.');
  assert.deepEqual(transcript.events.at(-1), {
    kind: 'assistant', phase: 'final_answer', text: 'The answer is 42.',
  });
});

test('transcript size stays below the completion limit and declares omitted content', () => {
  const transcript = runTranscript({ body: 'Inspect the run.' });
  for (let index = 0; index < 45; index += 1) addRunEvent(transcript, 'assistant', 'x'.repeat(800));
  finishRunTranscript(transcript, '🧭'.repeat(10_000));
  assert.equal(transcript.truncated, true);
  assert.ok(transcript.events.at(-1).text.length <= 8000);
  assert.ok(Buffer.byteLength(JSON.stringify(transcript)) <= 34_200);
});
