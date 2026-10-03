import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Lab } from './lab.mjs';
import { makeMime, readGeneratedMime, renderResult } from './mail.mjs';
import { parseInbound } from './inbound.mjs';

function freshLab(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wonder-email-lab-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  return { lab: new Lab(file, { seed: false }), file };
}

function rawTextMail({ from, subject, id, body, to = 'agent@wonder.test', cc, bcc, inReplyTo, references = [] }) {
  return Buffer.from([
    `From: ${from}`, `To: ${to}`,
    ...(cc ? [`Cc: ${cc}`] : []),
    ...(bcc ? [`Bcc: ${bcc}`] : []),
    `Subject: ${subject}`, `Message-ID: ${id}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`] : []),
    ...(references.length ? [`References: ${references.join(' ')}`] : []),
    'Content-Type: text/plain; charset=utf-8', '', body,
  ].join('\r\n'));
}

function rawGmailReaction({ from, id, targetId, emoji = '👍', version = 1 }) {
  return Buffer.from([
    `From: ${from}`, 'To: agent@wonder.test', `Message-ID: ${id}`, `In-Reply-To: ${targetId}`,
    'MIME-Version: 1.0', 'Content-Type: multipart/alternative; boundary="reaction"', '',
    '--reaction', 'Content-Type: text/plain; charset=utf-8', '', 'Reacted via Gmail.',
    '--reaction', 'Content-Type: text/vnd.google.email-reaction+json; charset=utf-8', '',
    JSON.stringify({ version, emoji }),
    '--reaction', 'Content-Type: text/html; charset=utf-8', '', '<p>Reacted via Gmail.</p>',
    '--reaction--', '',
  ].join('\r\n'));
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

test('owner grants To, Cc, and Bcc recipients thread access and can revoke it', (t) => {
  const { lab } = freshLab(t);
  const owner = lab.send({ from: 'owner@gmail.com', to: 'agent@wonder.test, to@gmail.com', cc: 'cc@gmail.com', bcc: 'hidden@gmail.com', subject: 'Shared work', body: 'Let us review this.' });
  const firstMail = lab.state.threads[0].messages[0].id;
  const thread = lab.state.threads[0];
  assert.deepEqual(Object.keys(thread.guests).sort(), ['cc@gmail.com', 'hidden@gmail.com', 'to@gmail.com']);
  assert.equal(thread.guests['hidden@gmail.com'].hidden, true);
  for (const address of Object.keys(thread.guests)) {
    assert.equal(lab.send({ from: address, subject: 'Re: Shared work', body: 'I can take the next step.', replyTo: firstMail }).accepted, true);
  }
  assert.equal(lab.send({ from: 'cc@gmail.com', subject: 'Re: Shared work', body: 'Attempt invite', cc: 'new@gmail.com', replyTo: firstMail }).accepted, true);
  assert.equal(thread.guests['new@gmail.com'], undefined);
  assert.equal(lab.send({ from: 'new@gmail.com', subject: 'Re: Shared work', body: 'Uninvited', replyTo: firstMail }).accepted, false);
  assert.equal(lab.send({ from: 'hidden@gmail.com', subject: 'New work', body: 'New task' }).accepted, false);
  lab.setOnline(true);
  lab.processNext();
  const firstAgent = thread.messages.find((message) => message.direction === 'outbound');
  assert.deepEqual(firstAgent.cc, ['to@gmail.com', 'cc@gmail.com']);
  assert.deepEqual(firstAgent.bcc, ['hidden@gmail.com']);
  assert.deepEqual(firstAgent.envelopeRecipients, ['owner@gmail.com', 'to@gmail.com', 'cc@gmail.com', 'hidden@gmail.com']);
  assert.doesNotMatch(firstAgent.mime, /hidden@gmail\.com/);
  assert.equal(lab.react({ from: 'hidden@gmail.com', targetId: firstAgent.id, emoji: '👍' }).accepted, false);
  lab.guestAction(owner.threadId, 'cc@gmail.com', 'revoke');
  assert.equal(lab.send({ from: 'cc@gmail.com', subject: 'Re: Shared work', body: 'After revoke', replyTo: firstMail }).accepted, false);
});

test('raw MIME owner mail adds To, Cc, and Bcc participants without exposing Bcc', async (t) => {
  const { lab } = freshLab(t);
  const first = await lab.importMime(rawTextMail({
    from: 'owner@gmail.com', to: 'visible@gmail.com', cc: 'agent@wonder.test, teammate@gmail.com',
    bcc: 'hidden@gmail.com', id: '<owner-recipients@example.test>', subject: 'Shared briefing', body: 'Please summarize.',
  }));
  assert.equal(first.accepted, true);
  const thread = lab.state.threads[0];
  assert.deepEqual(Object.keys(thread.guests).sort(), ['hidden@gmail.com', 'teammate@gmail.com', 'visible@gmail.com']);
  assert.equal(thread.guests['hidden@gmail.com'].hidden, true);
  lab.setOnline(true);
  lab.processNext();
  const reply = thread.messages.at(-1);
  assert.match(reply.mime, /Cc: visible@gmail\.com, teammate@gmail\.com/);
  assert.doesNotMatch(reply.mime, /hidden@gmail\.com/);
  assert.ok(reply.envelopeRecipients.includes('hidden@gmail.com'));
  const hiddenFollowup = await lab.importMime(rawTextMail({
    from: 'hidden@gmail.com', id: '<hidden-reply@example.test>', subject: 'Re: Shared briefing',
    inReplyTo: reply.id, body: 'I can add context.',
  }));
  assert.equal(hiddenFollowup.threadId, first.threadId);
  lab.processNext();
  const privateReply = thread.messages.at(-1);
  assert.equal(privateReply.to, 'hidden@gmail.com');
  assert.deepEqual(privateReply.cc, []);
  assert.deepEqual(privateReply.envelopeRecipients, ['hidden@gmail.com']);
});

test('Gmail MIME reactions stay on the agent message and never queue work', async (t) => {
  const { lab, file } = freshLab(t);
  lab.setOnline(true);
  const first = lab.send({ from: 'owner@gmail.com', subject: 'React to the result', body: 'Give a preview.', cc: 'guest@gmail.com' });
  lab.processNext();
  const agentMessage = lab.state.threads[0].messages.at(-1);
  const ownerReaction = rawGmailReaction({ from: 'owner@gmail.com', id: '<reaction-1@example.test>', targetId: agentMessage.id });
  assert.equal((await lab.importMime(ownerReaction)).accepted, true);
  assert.equal((await lab.importMime(ownerReaction)).duplicate, true);
  assert.equal((await lab.importMime(rawGmailReaction({ from: 'guest@gmail.com', id: '<reaction-2@example.test>', targetId: agentMessage.id, emoji: '❤️' }))).accepted, true);
  assert.equal((await lab.importMime(rawGmailReaction({ from: 'stranger@gmail.com', id: '<reaction-3@example.test>', targetId: agentMessage.id }))).accepted, false);
  await assert.rejects(lab.importMime(rawGmailReaction({ from: 'owner@gmail.com', id: '<reaction-4@example.test>', targetId: agentMessage.id, version: 2 })), /Invalid Gmail reaction/);
  assert.equal(lab.state.jobs.length, 1);
  assert.equal(lab.state.threads[0].messages.length, 2);
  assert.deepEqual(agentMessage.reactions.map((reaction) => reaction.emoji), ['👍', '❤️']);
  assert.equal(new Lab(file, { seed: false }).findMessage(agentMessage.id).message.reactions.length, 2);
  assert.equal(first.threadId, lab.state.threads[0].id);
});

test('owner and invited guest continue one MIME thread across turns, restart, and revocation', async (t) => {
  const { lab, file } = freshLab(t);
  lab.setOnline(true);

  const ownerId = '<owner-turn-1@example.test>';
  const first = await lab.importMime(rawTextMail({
    from: 'owner@gmail.com', cc: 'guest@gmail.com', subject: 'Shared launch review', id: ownerId,
    body: 'Model: Codex\nOutline the launch review.',
  }));
  assert.equal(first.accepted, true);
  assert.equal(lab.state.jobs[0].model.id, 'gpt-6.1-sol');
  assert.equal(lab.state.jobs[0].model.source, 'explicit');
  assert.equal(lab.processNext().state, 'completed');
  const firstAgent = lab.findMessage(ownerId).thread.messages.at(-1);
  assert.equal(firstAgent.replyTo, ownerId);
  assert.deepEqual(firstAgent.cc, ['guest@gmail.com']);
  assert.ok(firstAgent.mime.includes('Cc: guest@gmail.com'));
  assert.ok(firstAgent.mime.includes(`In-Reply-To: ${ownerId}`));
  assert.ok(firstAgent.mime.includes(`References: ${ownerId}`));

  const guestId = '<guest-turn-2@example.test>';
  const guestMail = rawTextMail({
    from: 'guest@gmail.com', subject: 'Re: Shared launch review', id: guestId,
    inReplyTo: firstAgent.id, references: [ownerId, firstAgent.id],
    body: 'Model: Claude\nPlease add risks to the review.',
  });
  assert.equal((await lab.importMime(guestMail)).threadId, first.threadId);
  assert.equal((await lab.importMime(guestMail)).duplicate, true);
  assert.equal(lab.state.jobs.length, 2);
  assert.deepEqual(lab.state.jobs[1].model, { id: 'claude-sonnet-5-5', effort: 'medium', source: 'explicit' });

  const resumed = new Lab(file, { seed: false });
  assert.equal(resumed.processNext().state, 'completed');
  const shared = resumed.state.threads.find((thread) => thread.id === first.threadId);
  const secondAgent = shared.messages.at(-1);
  assert.equal(secondAgent.to, 'guest@gmail.com');
  assert.deepEqual(secondAgent.cc, ['owner@gmail.com']);
  assert.ok(secondAgent.mime.includes('Cc: owner@gmail.com'));
  assert.equal(secondAgent.replyTo, guestId);
  assert.ok(secondAgent.mime.includes(`In-Reply-To: ${guestId}`));
  assert.ok(secondAgent.mime.includes(`References: ${ownerId} ${firstAgent.id} ${guestId}`));
  assert.match(readGeneratedMime(secondAgent.mime).text, /Reply to this email to continue the same task/);

  const ownerFollowupId = '<owner-turn-3@example.test>';
  const followup = await resumed.importMime(rawTextMail({
    from: 'owner@gmail.com', cc: 'guest@gmail.com', subject: 'Re: Shared launch review', id: ownerFollowupId,
    inReplyTo: secondAgent.id, references: [ownerId, firstAgent.id, guestId, secondAgent.id],
    body: 'Model: Luna\nCombine the outline and risks.',
  }));
  assert.equal(followup.threadId, first.threadId);
  assert.deepEqual(resumed.state.jobs[2].model, { id: 'gpt-6-luna', effort: 'low', source: 'explicit' });
  assert.equal(resumed.processNext().state, 'completed');
  const thirdAgent = shared.messages.at(-1);
  assert.equal(thirdAgent.to, 'owner@gmail.com');
  assert.deepEqual(thirdAgent.cc, ['guest@gmail.com']);
  assert.ok(thirdAgent.mime.includes('Cc: guest@gmail.com'));
  assert.equal(thirdAgent.replyTo, ownerFollowupId);
  assert.ok(thirdAgent.mime.includes(`In-Reply-To: ${ownerFollowupId}`));
  assert.ok(thirdAgent.mime.includes(`References: ${ownerId} ${firstAgent.id} ${guestId} ${secondAgent.id} ${ownerFollowupId}`));
  assert.equal(shared.messages.length, 6);
  assert.equal(resumed.state.threads.length, 1);
  assert.deepEqual(resumed.state.jobs.map((job) => job.state), ['completed', 'completed', 'completed']);

  const privateThread = resumed.send({ from: 'owner@gmail.com', subject: 'Private task', body: 'Keep this separate.' });
  const privateAgentParent = resumed.findMessage(resumed.state.jobs.at(-1).requestMessageId).message.id;
  const unauthorized = await resumed.importMime(rawTextMail({
    from: 'guest@gmail.com', subject: 'Re: Private task', id: '<guest-cross-thread@example.test>',
    inReplyTo: privateAgentParent, body: 'Please include me.',
  }));
  assert.equal(unauthorized.accepted, false);
  assert.notEqual(privateThread.threadId, first.threadId);
  assert.equal((await resumed.importMime(rawTextMail({
    from: 'guest@gmail.com', subject: 'New task', id: '<guest-new-thread@example.test>', body: 'Start a separate task.',
  }))).accepted, false);

  resumed.guestAction(first.threadId, 'guest@gmail.com', 'revoke');
  assert.equal(shared.guests['guest@gmail.com'].authorized, false);
  assert.equal((await resumed.importMime(rawTextMail({
    from: 'guest@gmail.com', subject: 'Re: Shared launch review', id: '<guest-after-revoke@example.test>',
    inReplyTo: thirdAgent.id, body: 'Continue after revocation.',
  }))).accepted, false);
  assert.equal(resumed.state.jobs.length, 4);
  assert.equal(new Lab(file, { seed: false }).state.threads.find((thread) => thread.id === first.threadId).messages.length, 6);
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

test('generic mock reply clearly labels itself as a preview', (t) => {
  const { lab } = freshLab(t);
  lab.setOnline(true);
  lab.send({ from: 'owner@gmail.com', subject: 'Project question', body: 'What is the codename?' });
  assert.equal(lab.processNext().state, 'completed');
  const reply = lab.state.threads[0].messages.at(-1);
  assert.match(reply.text, /^Synthetic preview\n/);
  assert.match(reply.text, /No agent answered the request/);
  assert.doesNotMatch(reply.text, /^Task completed\n/);
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

test('a renewed claim stays assigned and a real Codex result is labeled honestly', (t) => {
  const { lab } = freshLab(t);
  lab.send({ from: 'owner@gmail.com', subject: 'Local read', body: 'Summarize the selected files.' });
  const claim = lab.claimNext();
  lab.state.jobs[0].claimedAt = new Date(Date.now() - 61_000).toISOString();
  assert.equal(lab.renewClaim(claim.jobId, claim.claimId).renewed, true);
  assert.equal(lab.claimNext().claimed, false);
  assert.equal(lab.completeClaim(claim.jobId, claim.claimId, {
    runtime: 'codex-app-server-readonly', state: 'completed', summary: 'Codex read the selected workspace.',
  }).state, 'completed');
  assert.equal(lab.state.jobs[0].runtime, 'codex-app-server-readonly');
  assert.match(lab.state.threads[0].messages.at(-1).text, /Codex completed locally in read-only mode/);
  assert.throws(() => lab.renewClaim(claim.jobId, claim.claimId), /expired or been replaced/);
});

test('a real Claude result keeps its runtime label in the email thread', (t) => {
  const { lab } = freshLab(t);
  lab.send({ from: 'owner@gmail.com', subject: 'Local Claude read', body: 'Model: Claude\nRead the selected note.' });
  const claim = lab.claimNext();
  assert.equal(lab.completeClaim(claim.jobId, claim.claimId, {
    runtime: 'claude-cli-readonly', state: 'completed', summary: 'Claude read the note.',
  }).state, 'completed');
  assert.equal(lab.state.jobs[0].runtime, 'claude-cli-readonly');
  assert.match(lab.state.threads[0].messages.at(-1).text, /Claude completed locally in read-only mode/);
});

test('an opt-in Codex write result is labeled with its workspace access', (t) => {
  const { lab } = freshLab(t);
  lab.send({ from: 'owner@gmail.com', subject: 'Local edit', body: 'Edit the selected file.' });
  const claim = lab.claimNext();
  assert.equal(lab.completeClaim(claim.jobId, claim.claimId, {
    runtime: 'codex-app-server-write', state: 'completed', summary: 'Codex edited the selected file.',
  }).state, 'completed');
  assert.equal(lab.state.jobs[0].runtime, 'codex-app-server-write');
  assert.match(lab.state.threads[0].messages.at(-1).text, /Codex completed locally with selected-workspace write access/);
});

test('the mock approval button cannot requeue a real agent permission request', (t) => {
  const { lab } = freshLab(t);
  lab.send({ from: 'owner@gmail.com', subject: 'Needs local access', body: 'Check a file outside this workspace.' });
  const claim = lab.claimNext();
  assert.equal(lab.completeClaim(claim.jobId, claim.claimId, {
    runtime: 'codex-app-server-write', state: 'needs_approval', summary: 'Codex requested outside access.',
  }).state, 'needs_approval');
  assert.throws(() => lab.approveJob(claim.jobId), /cannot be approved by the mock daemon/);
  assert.equal(lab.state.jobs[0].state, 'needs_approval');
});

test('the real-run worker can claim only the selected queued job', (t) => {
  const { lab } = freshLab(t);
  const first = lab.send({ from: 'owner@gmail.com', subject: 'First', body: 'First task.' });
  const second = lab.send({ from: 'owner@gmail.com', subject: 'Second', body: 'Second task.' });
  assert.equal(lab.claimNext('job-missing').claimed, false);
  assert.equal(lab.claimNext(second.jobId).jobId, second.jobId);
  assert.equal(lab.state.jobs.find((job) => job.id === first.jobId).state, 'queued');
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

test('raw MIME import decodes HTML and image bytes, then follows References', async (t) => {
  const { lab, file } = freshLab(t);
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==';
  const raw = [
    'From: Owner <owner@gmail.com>', 'To: agent@wonder.test', 'Subject: =?UTF-8?B?VGVzdCDwn5iA?=',
    'Message-ID: <import-1@example.test>', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="demo"', '',
    '--demo', 'Content-Type: text/html; charset=utf-8', '',
    '<p>Please inspect <strong>this image</strong>.</p>',
    '--demo', 'Content-Type: image/png', 'Content-Disposition: attachment; filename="sample.png"',
    'Content-Transfer-Encoding: base64', '', png, '--demo--', '',
  ].join('\r\n');
  const first = await lab.importMime(Buffer.from(raw));
  assert.equal(first.accepted, true);
  const message = lab.findMessage('<import-1@example.test>').message;
  assert.match(message.text, /Please inspect this image/);
  assert.equal(message.attachments[0].name, 'sample.png');
  assert.equal(message.attachments[0].previewable, true);
  assert.deepEqual(lab.attachment(message.id, message.attachments[0].id).bytes, Buffer.from(png, 'base64'));
  assert.equal(lab.snapshot().threads[0].messages[0].attachments[0].data, undefined);
  assert.equal((await lab.importMime(Buffer.from(raw))).duplicate, true);
  const restarted = new Lab(file, { seed: false });
  assert.deepEqual(restarted.attachment(message.id, message.attachments[0].id).bytes, Buffer.from(png, 'base64'));

  const reply = ['From: owner@gmail.com', 'To: agent@wonder.test', 'Subject: Re: Test',
    'Message-ID: <import-2@example.test>', 'References: <import-1@example.test>',
    'Content-Type: text/plain; charset=utf-8', '', 'Please continue.'].join('\r\n');
  const next = await lab.importMime(Buffer.from(reply));
  assert.equal(next.threadId, first.threadId);
  assert.equal(lab.state.threads.length, 1);
  assert.equal(lab.state.threads[0].messages.length, 2);
  assert.equal(new Lab(file, { seed: false }).claimNext().request.attachments[0].size, Buffer.from(png, 'base64').length);
});

test('raw MIME import rejects automated mail and unauthorized guest replies', async (t) => {
  const { lab } = freshLab(t);
  const auto = ['From: owner@gmail.com', 'To: agent@wonder.test', 'Message-ID: <auto@example.test>',
    'Auto-Submitted: auto-replied', 'Content-Type: text/plain', '', 'Away.'].join('\r\n');
  await assert.rejects(lab.importMime(Buffer.from(auto)), /Automatic response/);
  const owner = lab.send({ from: 'owner@gmail.com', subject: 'Shared', body: 'Please review.' });
  const parent = lab.state.threads[0].messages[0].id;
  const guest = ['From: guest@gmail.com', 'To: agent@wonder.test', 'Subject: Re: Shared',
    'Message-ID: <guest@example.test>', `In-Reply-To: ${parent}`,
    'Content-Type: text/plain', '', 'I have an idea.'].join('\r\n');
  assert.equal((await lab.importMime(Buffer.from(guest))).accepted, false);
  lab.send({ from: 'owner@gmail.com', subject: 'Re: Shared', body: 'Adding the guest.', cc: 'guest@gmail.com', replyTo: parent });
  assert.equal((await lab.importMime(Buffer.from(guest))).accepted, true);
});

test('raw MIME import bounds body and attachment size before persistence', async (t) => {
  const { lab } = freshLab(t);
  await assert.rejects(parseInbound(Buffer.alloc(5 * 1024 * 1024 + 1)), /between 1 byte and 5 MB/);
  const giant = Buffer.alloc(2 * 1024 * 1024 + 1).toString('base64');
  const raw = ['From: owner@gmail.com', 'To: agent@wonder.test', 'Message-ID: <large@example.test>',
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="large"', '',
    '--large', 'Content-Type: text/plain', '', 'Please inspect.',
    '--large', 'Content-Type: application/pdf', 'Content-Disposition: attachment; filename="large.pdf"',
    'Content-Transfer-Encoding: base64', '', giant, '--large--', ''].join('\r\n');
  await assert.rejects(lab.importMime(Buffer.from(raw)), /attachments exceed/);
  assert.equal(lab.state.jobs.length, 0);
});
