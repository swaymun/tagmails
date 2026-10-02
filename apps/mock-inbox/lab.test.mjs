import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Lab } from './lab.mjs';
import { makeMime, readGeneratedMime, renderResult } from './mail.mjs';

function freshLab(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wonder-email-lab-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  return { lab: new Lab(file, { seed: false }), file };
}

test('offline mail survives restart and produces a threaded multipart reply', (t) => {
  const { lab, file } = freshLab(t);
  const sent = lab.send({ from: 'owner@gmail.com', subject: 'Please summarize', body: 'What did we decide?' });
  assert.equal(lab.processNext().processed, false);
  const restarted = new Lab(file, { seed: false });
  assert.equal(restarted.state.jobs[0].state, 'queued');
  restarted.setOnline(true);
  assert.equal(restarted.processNext().state, 'completed');
  const thread = restarted.state.threads.find((item) => item.id === sent.threadId);
  assert.equal(thread.messages.length, 2);
  const outgoing = thread.messages[1];
  assert.match(outgoing.mime, /Content-Type: multipart\/alternative/);
  assert.match(outgoing.mime, new RegExp(`In-Reply-To: ${thread.messages[0].id.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(outgoing.mime.includes(`References: ${thread.messages[0].id}`));
  assert.match(readGeneratedMime(outgoing.mime).html, /No model was called/);
  assert.match(readGeneratedMime(outgoing.mime).text, /Reply to this email/);
});

test('a reply continues the same thread and honors explicit model routing', (t) => {
  const { lab } = freshLab(t);
  const first = lab.send({ from: 'owner@gmail.com', subject: 'Bug report', body: 'Find the cause.' });
  lab.setOnline(true);
  lab.processNext();
  const thread = lab.state.threads.find((item) => item.id === first.threadId);
  const agentMessage = thread.messages.at(-1);
  const followup = lab.send({ from: 'owner@gmail.com', subject: 'Re: Bug report', body: 'Model: Claude\nContinue with a test plan.', replyTo: agentMessage.id });
  assert.equal(followup.threadId, first.threadId);
  assert.equal(lab.state.threads.length, 1);
  assert.deepEqual(lab.state.jobs.at(-1).model, { id: 'claude-sonnet-5-5', effort: 'medium', source: 'explicit' });
  lab.processNext();
  assert.equal(thread.messages.length, 4);
  assert.ok(thread.messages.at(-1).references.includes(agentMessage.id));
});

test('duplicate Message-ID does not queue a second job', (t) => {
  const { lab } = freshLab(t);
  const input = { from: 'owner@gmail.com', subject: 'Once', body: 'Do this once.', messageId: '<same@wonder.test>' };
  lab.send(input);
  assert.equal(lab.send(input).duplicate, true);
  assert.equal(lab.state.jobs.length, 1);
});

test('CC guest must be verified and owner approved for the same thread', (t) => {
  const { lab } = freshLab(t);
  const owner = lab.send({ from: 'owner@gmail.com', subject: 'Shared work', body: 'Let us review this.', cc: 'guest@gmail.com' });
  const firstMail = lab.state.threads[0].messages[0].id;
  const guest = { from: 'guest@gmail.com', subject: 'Re: Shared work', body: 'I can take the next step.', replyTo: firstMail };
  assert.equal(lab.send(guest).accepted, false);
  lab.guestAction(owner.threadId, 'guest@gmail.com', 'verify');
  assert.equal(lab.send(guest).accepted, false);
  lab.guestAction(owner.threadId, 'guest@gmail.com', 'approve');
  assert.equal(lab.send(guest).accepted, true);
  assert.equal(lab.state.jobs.length, 2);
  assert.equal(lab.send({ from: 'guest@gmail.com', subject: 'New work', body: 'New task' }).accepted, false);
});

test('approval pauses a job and a failed fixture sends one terminal response', (t) => {
  const { lab } = freshLab(t);
  lab.setOnline(true);
  lab.send({ from: 'owner@gmail.com', subject: 'Launch', body: 'Please deploy the site.' });
  const waiting = lab.processNext();
  assert.equal(waiting.state, 'needs_approval');
  assert.equal(lab.processNext().processed, false);
  lab.approveJob(waiting.jobId);
  assert.equal(lab.processNext().state, 'completed');
  assert.equal(lab.state.threads[0].messages.length, 3);
  lab.send({ from: 'owner@gmail.com', subject: 'Failure case', body: '[simulate:fail]' });
  assert.equal(lab.processNext().state, 'failed');
  assert.equal(lab.processNext().processed, false);
});

test('renderer escapes hostile content and rejects header injection', () => {
  const result = renderResult({ state: 'completed', summary: '<script>alert(1)</script>', details: [], checks: [], links: [{ label: 'bad', url: 'javascript:alert(1)' }], note: 'safe' });
  assert.ok(result.html.includes('&lt;script&gt;'));
  assert.ok(!result.html.includes('href="javascript:'));
  assert.throws(() => makeMime({ from: 'agent@wonder.test', to: 'owner@gmail.com', subject: 'Hello\r\nBcc: victim@example.com', messageId: '<id@wonder.test>', text: 'a', html: '<p>a</p>' }), /line break/);
});

test('interrupted mock work is returned to the durable queue', (t) => {
  const { lab, file } = freshLab(t);
  lab.send({ from: 'owner@gmail.com', subject: 'Recover', body: 'Keep this queued.' });
  lab.state.jobs[0].state = 'running';
  lab.save();
  const restarted = new Lab(file, { seed: false });
  assert.equal(restarted.state.jobs[0].state, 'queued');
  assert.equal(restarted.state.events[0].type, 'recovered');
});

test('Rust claim completes once and an expired claim cannot complete newer work', (t) => {
  const { lab } = freshLab(t);
  lab.send({ from: 'owner@gmail.com', subject: 'Worker handoff', body: 'Summarize the plan.' });
  const first = lab.claimNext();
  assert.equal(first.claimed, true);
  assert.equal(lab.claimNext().claimed, false);
  lab.state.jobs[0].claimedAt = new Date(Date.now() - 61_000).toISOString();
  const replacement = lab.claimNext();
  assert.equal(replacement.jobId, first.jobId);
  assert.notEqual(replacement.claimId, first.claimId);
  const result = { state: 'completed', summary: 'The synthetic worker finished.' };
  assert.throws(() => lab.completeClaim(first.jobId, first.claimId, result), /expired or been replaced/);
  assert.equal(lab.completeClaim(replacement.jobId, replacement.claimId, result).state, 'completed');
  assert.equal(lab.completeClaim(replacement.jobId, replacement.claimId, result).duplicate, true);
  assert.equal(lab.state.threads[0].messages.length, 2);
});

test('the seeded inbox shows seven use cases with newest mail first', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-seed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const lab = new Lab(path.join(directory, 'state.json'));
  const threads = lab.snapshot().threads;
  assert.equal(threads.length, 7);
  assert.equal(threads[0].subject, 'Review this plan together');
  assert.equal(threads[1].subject, 'Screenshot missing from the task trace');
  assert.equal(lab.snapshot().online, false);
});
