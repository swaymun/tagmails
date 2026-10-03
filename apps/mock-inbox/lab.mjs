import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml, makeMime, readGeneratedMime, renderResult } from './mail.mjs';
import { parseInbound } from './inbound.mjs';

const OWNER = 'owner@gmail.com';
const AGENT = 'agent@wonder.test';
const MESSAGE_ID = /^<[^<>@\s]+@[^<>@\s]+>$/;

function now() { return new Date().toISOString(); }
function cleanAddress(value) { return String(value ?? '').trim().toLowerCase(); }
function validAddress(value) { return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value); }
function short(value, max) { return String(value ?? '').trim().slice(0, max); }
function recipientList(value) {
  return [...new Set((Array.isArray(value) ? value : String(value ?? '').split(',')).map(cleanAddress).filter(Boolean))];
}

function chooseModel(body) {
  const requested = body.match(/^Model:\s*(.+)$/im)?.[1]?.trim().toLowerCase();
  if (!requested) return { id: 'gpt-6.1-sol', effort: 'medium', source: 'default' };
  const choices = {
    'codex': ['gpt-6.1-sol', 'medium'],
    'gpt-6.1-sol': ['gpt-6.1-sol', 'medium'],
    'gpt-6.1-sol medium': ['gpt-6.1-sol', 'medium'],
    'claude': ['claude-sonnet-5-5', 'medium'],
    'sonnet': ['claude-sonnet-5-5', 'medium'],
    'claude-sonnet-5-5': ['claude-sonnet-5-5', 'medium'],
    'claude-sonnet-5-5 medium': ['claude-sonnet-5-5', 'medium'],
    'luna': ['gpt-6-luna', 'low'],
    'gpt-6-luna': ['gpt-6-luna', 'low'],
  };
  const choice = choices[requested];
  return choice ? { id: choice[0], effort: choice[1], source: 'explicit' } : { error: `“${short(requested, 80)}” is not available in this test. Use Codex, Claude, or Luna.` };
}

function newState() {
  return { version: 1, counter: 0, online: false, workerHeartbeat: null, threads: [], jobs: [], events: [] };
}

export class Lab {
  constructor(file, { seed = true, origin = 'http://127.0.0.1:4177' } = {}) {
    this.file = file;
    this.origin = origin;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : newState();
    if (this.state.version !== 1) throw new Error('Unsupported local lab data version');
    for (const job of this.state.jobs) {
      if (job.state === 'running') {
        job.state = 'queued';
        delete job.claimId;
        delete job.claimedAt;
        this.event('recovered', 'Interrupted mock job returned to the queue.', job.threadId, job.id);
      }
    }
    if (!fs.existsSync(file)) {
      if (seed) this.seed();
      else this.save();
    } else this.save();
  }

  save() {
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2));
    fs.renameSync(temporary, this.file);
  }

  next(prefix) { this.state.counter += 1; return `${prefix}-${this.state.counter}`; }
  event(type, description, threadId = null, jobId = null) {
    this.state.events.unshift({ id: this.next('event'), type, description, threadId, jobId, at: now() });
    this.state.events = this.state.events.slice(0, 100);
  }

  seed() {
    this.state.online = true;
    this.send({ from: OWNER, subject: 'What did we decide for the beta?', body: 'Catch me up on the decisions in our launch thread and tell me what still needs an owner.', fixture: 'catchup' });
    this.processNext();
    this.send({ from: OWNER, subject: 'How did the pilot go this week?', body: 'Pull the weekly task numbers and explain what needs attention.', fixture: 'metrics' });
    this.processNext();
    this.send({ from: OWNER, subject: 'Prep me for the partner call', body: 'I am meeting a prospective pilot team. What should I know about the email workflow and open decisions?', fixture: 'callprep' });
    this.processNext();
    this.send({ from: OWNER, subject: 'Check this stopped run', body: 'Please inspect this fixture. [simulate:fail]' });
    this.processNext();
    this.send({ from: OWNER, subject: 'Publish the launch site', body: 'Please publish the launch site when the draft is ready. Ask me before any external action.' });
    this.processNext();
    this.state.online = false;
    this.send({ from: OWNER, subject: 'Screenshot missing from the task trace', body: 'A user reports that an attached screenshot disappears from the task trace. Find the cause and prepare a draft fix.', fixture: 'incident' });
    this.send({ from: OWNER, subject: 'Review this plan together', body: 'Can you summarize the open questions and let my teammate continue this thread once they have permission?', cc: 'teammate@gmail.com' });
    this.event('lab', 'Synthetic example messages loaded. The daemon is offline.');
    this.save();
  }

  snapshot() {
    const threads = this.state.threads.map((thread) => ({
      ...thread,
      messages: thread.messages.map(({ mime, attachments, ...message }) => ({
        ...message,
        attachments: (attachments ?? []).map(({ data, ...attachment }) => attachment),
      })),
    })).sort((a, b) => {
      const order = (message) => Number(String(message.order ?? '0').replace(/^order-/, '')) || 0;
      return order(b.messages.at(-1)) - order(a.messages.at(-1)) || b.messages.at(-1).at.localeCompare(a.messages.at(-1).at);
    });
    const workerLive = this.state.workerHeartbeat && Date.now() - Date.parse(this.state.workerHeartbeat) < 8_000;
    return { owner: OWNER, agent: AGENT, online: Boolean(this.state.online || workerLive), workerLive: Boolean(workerLive), threads, jobs: this.state.jobs, events: this.state.events };
  }

  findMessage(id) {
    for (const thread of this.state.threads) {
      const message = thread.messages.find((item) => item.id === id);
      if (message) return { thread, message };
    }
    return null;
  }

  attachment(messageId, attachmentId) {
    const item = this.findMessage(messageId)?.message.attachments?.find((attachment) => attachment.id === attachmentId);
    return item ? { ...item, bytes: Buffer.from(item.data, 'base64') } : null;
  }

  async importMime(raw) {
    const parsed = await parseInbound(raw, AGENT);
    if (parsed.reaction) return this.react({ from: parsed.from, messageId: parsed.messageId, targetId: parsed.reactionTargetId, emoji: parsed.reaction });
    const parent = parsed.parentIds.findLast((id) => this.findMessage(id));
    const result = this.send({
      from: parsed.from,
      to: parsed.to,
      cc: parsed.cc,
      bcc: parsed.bcc,
      subject: parsed.subject,
      body: parsed.body,
      messageId: parsed.messageId,
      replyTo: parent,
    });
    if (result.accepted && !result.duplicate) {
      const message = this.findMessage(parsed.messageId).message;
      message.attachments = parsed.attachments.map((attachment) => ({ id: this.next('attachment'), ...attachment }));
      this.event('attachment', `Imported ${message.attachments.length} attachment(s) from the .eml file.`, result.threadId, result.jobId);
      this.save();
    }
    return result;
  }

  send(input) {
    const from = cleanAddress(input.from);
    if (!validAddress(from)) throw new Error('Enter a valid sender address');
    const subject = short(input.subject || '(no subject)', 180);
    const body = short(input.body, 12000);
    if (!body) throw new Error('Write a task before sending');
    const to = recipientList(input.to ?? AGENT);
    const cc = recipientList(input.cc);
    const bcc = recipientList(input.bcc);
    if ([...to, ...cc, ...bcc].some((address) => !validAddress(address))) throw new Error('A recipient address is invalid');
    if (![...to, ...cc, ...bcc].includes(AGENT)) throw new Error(`Include ${AGENT} as a recipient`);
    const parentId = input.replyTo ? String(input.replyTo) : null;
    const parent = parentId ? this.findMessage(parentId) : null;
    if (parentId && !parent) throw new Error('The reply target is not in this lab');
    const thread = parent?.thread;
    if (from !== OWNER) {
      const invite = thread?.guests[from];
      if (!invite || !(invite.authorized ?? (invite.verified && invite.approved))) {
        this.event('rejected', `${from} cannot instruct the agent on this thread yet.`, thread?.id);
        this.save();
        return { accepted: false, reason: 'The owner has not included this sender on this thread, or has revoked access.' };
      }
    }
    const id = input.messageId ? String(input.messageId) : `<${this.next('mail')}@wonder.test>`;
    if (!MESSAGE_ID.test(id)) throw new Error('Message-ID is invalid');
    const duplicate = this.findMessage(id);
    if (duplicate) return { accepted: true, duplicate: true, threadId: duplicate.thread.id };
    const target = thread ?? { id: this.next('thread'), subject, guests: {}, messages: [] };
    if (!thread) this.state.threads.push(target);
    if (from === OWNER) {
      for (const address of [...to, ...cc, ...bcc]) {
        if (address === OWNER || address === AGENT) continue;
        const hidden = bcc.includes(address) && !to.includes(address) && !cc.includes(address);
        target.guests[address] = { authorized: true, hidden };
        this.event('invite', `Owner included ${address} on this thread${hidden ? ' as a Bcc recipient' : ''}.`, target.id);
      }
    }
    const references = [...(parent?.message.references ?? []), ...(parent ? [parent.message.id] : [])];
    target.messages.push({ id, direction: 'inbound', from, to: to.join(', '), cc, bcc, subject, text: body, at: now(), order: ++this.state.counter, references, replyTo: parentId });
    const model = chooseModel(body);
    const fixture = ['catchup', 'incident', 'metrics', 'callprep'].includes(input.fixture) ? input.fixture : null;
    const job = { id: this.next('job'), threadId: target.id, requestMessageId: id, state: 'queued', model, fixture, approved: false, createdAt: now() };
    this.state.jobs.push(job);
    this.event('queued', `Accepted mail from ${from}; ${this.state.online ? 'ready to process' : 'waiting for the daemon'}.`, target.id, job.id);
    this.save();
    return { accepted: true, duplicate: false, threadId: target.id, jobId: job.id };
  }

  setOnline(online) {
    this.state.online = Boolean(online);
    this.event('daemon', this.state.online ? 'Mock daemon connected.' : 'Mock daemon disconnected. Queued mail is retained.');
    this.save();
  }

  heartbeat() {
    const wasLive = this.state.workerHeartbeat && Date.now() - Date.parse(this.state.workerHeartbeat) < 8_000;
    this.state.workerHeartbeat = now();
    if (!wasLive) this.event('daemon', 'Rust mock daemon connected.');
    this.save();
  }

  claimNext(selectedJobId = null) {
    this.heartbeat();
    for (const job of this.state.jobs) {
      if (job.state === 'running' && job.claimedAt && Date.now() - Date.parse(job.claimedAt) > 60_000) {
        job.state = 'queued';
        delete job.claimId;
        delete job.claimedAt;
        this.event('recovered', 'Expired mock claim returned to the queue.', job.threadId, job.id);
      }
    }
    const job = this.state.jobs.find((item) => item.state === 'queued' && (!selectedJobId || item.id === selectedJobId));
    if (!job) { this.save(); return { claimed: false }; }
    const thread = this.state.threads.find((item) => item.id === job.threadId);
    const request = thread.messages.find((item) => item.id === job.requestMessageId);
    job.state = 'running';
    job.claimedAt = now();
    job.claimId = this.next('claim');
    this.event('running', `Rust mock daemon claimed the task for ${job.model.id ?? 'unresolved model'}.`, thread.id, job.id);
    this.save();
    return {
      claimed: true, jobId: job.id, claimId: job.claimId, threadId: thread.id,
      model: job.model, fixture: job.fixture, approved: job.approved,
      request: {
        from: request.from, subject: request.subject, body: request.text,
        attachments: (request.attachments ?? []).map(({ id, name, mimeType, size }) => ({
          name, mimeType, size,
          path: `/api/attachment?messageId=${encodeURIComponent(request.id)}&attachmentId=${encodeURIComponent(id)}`,
        })),
      },
    };
  }

  renewClaim(jobId, claimId) {
    const job = this.state.jobs.find((item) => item.id === jobId);
    if (!job || job.state !== 'running' || !claimId || job.claimId !== claimId) throw new Error('Mock claim has expired or been replaced');
    job.claimedAt = now();
    this.heartbeat();
    this.save();
    return { renewed: true };
  }

  completeClaim(jobId, claimId, input) {
    const job = this.state.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error('Claimed job not found');
    if (job.state !== 'running') return { duplicate: true, state: job.state };
    if (!claimId || claimId !== job.claimId) throw new Error('Mock claim has expired or been replaced');
    if (!input || !['completed', 'failed', 'needs_approval', 'needs_clarification'].includes(input.state)) throw new Error('Invalid mock result state');
    const realAgent = ['codex-cli-readonly', 'claude-cli-readonly'].includes(input.runtime);
    if (input.runtime && !realAgent) throw new Error('Unknown local runtime');
    const agent = input.runtime === 'claude-cli-readonly' ? 'Claude' : 'Codex';
    const result = {
      state: input.state,
      summary: short(input.summary, 500),
      details: Array.isArray(input.details) ? input.details.slice(0, 12).map((item) => short(item, 300)) : [],
      checks: Array.isArray(input.checks) ? input.checks.slice(0, 12).map((item) => short(item, 300)) : [],
      links: [{ label: realAgent ? 'View local run' : 'View simulated run', url: `${this.origin}/trace/${job.id}` }],
      note: realAgent
        ? `${input.state === 'completed' ? `${agent} CLI completed locally in read-only mode.` : `The local ${agent} route did not complete.`} This lab has not sent or received a real email.`
        : 'Synthetic response from the local Rust mock daemon. No model was called and no files were changed.',
    };
    if (!result.summary) throw new Error('Mock result needs a summary');
    const thread = this.state.threads.find((item) => item.id === job.threadId);
    const request = thread.messages.find((item) => item.id === job.requestMessageId);
    job.state = result.state;
    if (realAgent) job.runtime = input.runtime;
    delete job.claimedAt;
    delete job.claimId;
    this.reply(thread, request, job, result);
    this.event(result.state, result.summary, thread.id, job.id);
    this.save();
    return { duplicate: false, state: job.state };
  }

  guestAction(threadId, email, action) {
    const thread = this.state.threads.find((item) => item.id === threadId);
    const address = cleanAddress(email);
    const invite = thread?.guests[address];
    if (!invite) throw new Error('No CC invitation exists for this address and thread');
    if (action === 'revoke') invite.authorized = false;
    else throw new Error('Unknown invitation action');
    this.event('invite', `${address}: owner revoked access to this thread.`, threadId);
    this.save();
    return invite;
  }

  react({ from, messageId, targetId, emoji }) {
    const address = cleanAddress(from);
    const target = this.findMessage(targetId);
    if (!target || target.message.direction !== 'outbound') throw new Error('The reaction target must be an agent reply in this lab');
    const visibleRecipients = [target.message.to, ...target.message.cc].flatMap(recipientList);
    const invited = address === OWNER || (target.thread.guests[address]?.authorized ?? (target.thread.guests[address]?.verified && target.thread.guests[address]?.approved));
    if (!invited || !visibleRecipients.includes(address)) {
      this.event('rejected', `${address} cannot react to this agent message.`, target.thread.id);
      this.save();
      return { accepted: false, reason: 'Sender cannot react to this agent message.' };
    }
    if (typeof emoji !== 'string' || [...new Intl.Segmenter().segment(emoji)].length !== 1 || !/\p{Extended_Pictographic}|\p{Emoji_Presentation}|\uFE0F/u.test(emoji)) throw new Error('Choose one emoji');
    const id = messageId ?? `<${this.next('reaction')}@wonder.test>`;
    if (!MESSAGE_ID.test(id)) throw new Error('Reaction Message-ID is invalid');
    for (const thread of this.state.threads) {
      for (const message of thread.messages) {
        if (message.reactions?.some((reaction) => reaction.id === id)) return { accepted: true, duplicate: true, threadId: thread.id };
      }
    }
    target.message.reactions ??= [];
    target.message.reactions.push({ id, from: address, emoji, at: now() });
    this.event('reaction', `${address} reacted ${emoji} to an agent reply.`, target.thread.id);
    this.save();
    return { accepted: true, duplicate: false, threadId: target.thread.id };
  }

  approveJob(jobId) {
    const job = this.state.jobs.find((item) => item.id === jobId);
    if (!job || job.state !== 'needs_approval') throw new Error('No approval is pending for this job');
    job.approved = true;
    job.state = 'queued';
    this.event('approval', 'Owner approved the simulated side effect.', job.threadId, job.id);
    this.save();
  }

  processNext() {
    if (!this.snapshot().online) return { processed: false, reason: 'The mock daemon is offline.' };
    const job = this.state.jobs.find((item) => item.state === 'queued');
    if (!job) return { processed: false, reason: 'There is no queued mail.' };
    const thread = this.state.threads.find((item) => item.id === job.threadId);
    const request = thread.messages.find((item) => item.id === job.requestMessageId);
    job.state = 'running';
    this.event('running', `Mock runtime started with ${job.model.id ?? 'unresolved model'}.`, thread.id, job.id);
    this.save();

    const traceLink = { label: 'View simulated run', url: `${this.origin}/trace/${job.id}` };
    let result;
    if (job.model.error) {
      result = { state: 'needs_clarification', summary: job.model.error, details: [], checks: [], links: [], note: 'This is a synthetic email preview. No model was called.' };
    } else if (!job.approved && /\b(deploy|purchase|merge|send (?:an? )?email|publish)\b/i.test(request.text)) {
      result = { state: 'needs_approval', summary: 'This request includes an external or sensitive action. Approve it in the local lab before the mock runner continues.', details: [`Requested model: ${job.model.id} (${job.model.effort})`], checks: ['No external action has happened.'], links: [traceLink], note: 'This is a synthetic email preview. No model was called.' };
    } else if (request.text.includes('[simulate:fail]')) {
      result = { state: 'failed', summary: 'The mock runner stopped at the requested failure fixture.', details: [], checks: ['No files changed and no external action occurred.'], links: [traceLink], note: 'This is a synthetic failure preview.' };
    } else if (job.fixture === 'catchup') {
      result = { state: 'completed', summary: 'The beta plan centers on emailing an existing local Codex or Claude agent, then replying in the same thread to continue the work.', details: ['Decided: Google sign-in with a verified Gmail sender for the first beta.', 'Decided: keep model credentials and project execution on the customer’s Mac.', 'Decided: TagMails is the public brand. Still open: domain purchase, source license, and final retention and pricing settings.'], checks: ['This answer uses a synthetic fixture based on the local plan; no external source or model was queried.'], links: [traceLink], note: 'Synthetic example for email layout testing. No model was called.' };
    } else if (job.fixture === 'incident') {
      result = { state: 'completed', summary: 'Draft investigation: the screenshot must travel as an authenticated attachment through persistence and trace rendering.', details: ['Trace the inbound attachment bytes, stored object reference, and viewer payload.', 'Prepare a draft fix that preserves the image after daemon restart.', 'Ask for a real test email before claiming the issue is resolved.'], checks: ['This is a simulated investigation. No code changed and no PR was opened.'], links: [traceLink], note: 'Synthetic example for email layout testing. No model was called.' };
    } else if (job.fixture === 'metrics') {
      result = { state: 'completed', summary: 'Illustrative weekly snapshot: 18 requests received, 15 completed, 2 waiting for approval, and 1 failed.', details: ['The most common request in this sample set was a project summary.', 'Three follow-up emails continued an existing thread.'], checks: ['These figures are invented fixture data; no production database was queried.'], links: [traceLink], note: 'Synthetic example for email layout testing. No model was called.' };
    } else if (job.fixture === 'callprep') {
      result = { state: 'completed', summary: 'Call prep draft: lead with the email-native workflow, then ask whether the team needs shared threads or private agent addresses.', details: ['Show one task email, the completed reply, and the trace link.', 'Keep domain and pricing questions open until the pilot has measured delivery and storage usage.'], checks: ['This is a synthetic brief. No calendar, CRM, or private data was accessed.'], links: [traceLink], note: 'Synthetic example for email layout testing. No model was called.' };
    } else {
      result = { state: 'completed', summary: `I received your request about “${short(request.text.replace(/^Model:.*$/gim, '').trim().replace(/\s+/g, ' '), 88)}”.`, details: [`The ${job.model.id} (${job.model.effort}) route was selected${job.model.source === 'explicit' ? ' from your email' : ' by default'}.`, 'This mock run demonstrates the response format and thread continuity.'], checks: ['No model was called and no files changed in this preview.'], links: [traceLink], note: 'This is a synthetic email preview. Real run claims will appear only after a runtime is connected.' };
    }
    job.state = result.state;
    this.reply(thread, request, job, result);
    this.event(result.state, result.summary, thread.id, job.id);
    this.save();
    return { processed: true, jobId: job.id, state: job.state };
  }

  reply(thread, request, job, result) {
    const { html, text } = renderResult(result);
    const last = thread.messages.at(-1);
    const references = [...request.references, request.id];
    const id = `<${this.next('mail')}@wonder.test>`;
    const subject = /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`;
    const visible = [...recipientList(request.to), ...request.cc];
    const approvedVisible = (address) => address !== AGENT && address !== request.from && (address === OWNER || (thread.guests[address]?.authorized && !thread.guests[address]?.hidden));
    const ownerWasVisible = visible.includes(OWNER);
    const senderWasHidden = thread.guests[request.from]?.hidden;
    const cc = request.from === OWNER
      ? visible.filter((address) => address !== OWNER && address !== AGENT && thread.guests[address]?.authorized)
      : [...(senderWasHidden && !ownerWasVisible ? [] : [OWNER]), ...visible.filter(approvedVisible)];
    const recipients = [...new Set(cc)].filter((address) => address !== request.from);
    const bcc = request.from === OWNER ? (request.bcc ?? []).filter((address) => address !== AGENT && address !== OWNER && !recipients.includes(address) && thread.guests[address]?.authorized) : [];
    const envelopeRecipients = [...new Set([request.from, ...recipients, ...bcc])];
    const mime = makeMime({ from: AGENT, to: request.from, cc: recipients, subject, messageId: id, inReplyTo: request.id, references, text, html });
    const rendered = readGeneratedMime(mime);
    thread.messages.push({ id, direction: 'outbound', from: AGENT, to: request.from, cc: recipients, bcc, envelopeRecipients, subject, text: rendered.text, at: now(), order: ++this.state.counter, references, replyTo: request.id, jobId: job.id, mime, after: last.id });
  }

  preview(messageId) {
    const found = this.findMessage(messageId);
    if (!found) return null;
    if (found.message.mime) return readGeneratedMime(found.message.mime).html;
    return `<html lang="en"><meta charset="utf-8"><style>body{font:14px/1.6 Arial,sans-serif;color:#202124;padding:12px 18px;white-space:pre-wrap}</style><body>${escapeHtml(found.message.text)}</body></html>`;
  }

  reset() {
    this.state = newState();
    this.seed();
  }
}
