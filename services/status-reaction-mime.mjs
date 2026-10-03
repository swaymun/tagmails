const MESSAGE_ID = /^<[^<>\s]+@[^<>\s]+>$/;
const ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
const JOB_ID = /^[0-9a-f-]{36}$/i;

const STATUS = {
  received: { emoji: '👀', text: 'TagMails received your request.' },
  working: { emoji: '📝', text: 'TagMails is working on your request.' },
  completed: { emoji: '✅', text: 'TagMails completed your request. A result email will follow.' },
  failed: { emoji: '⚠️', text: 'TagMails could not complete your request. An explanation will follow.' },
};

export function buildStatusReaction({ jobId, status, from, to, targetMessageId }) {
  const selected = STATUS[status];
  if (!selected || !JOB_ID.test(jobId ?? '') || !ADDRESS.test(from ?? '') ||
      !ADDRESS.test(to ?? '') || !MESSAGE_ID.test(targetMessageId ?? '')) {
    throw new Error('Invalid status reaction');
  }
  const boundary = `tagmails-${jobId}-${status}`;
  const reaction = Buffer.from(JSON.stringify({ version: 1, emoji: selected.emoji })).toString('base64');
  const raw = [
    `From: <${from}>`, `To: <${to}>`, 'Subject: Re: Your TagMails request',
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${jobId}.${status}@${from.split('@')[1]}>`,
    `In-Reply-To: ${targetMessageId}`, `References: ${targetMessageId}`,
    `Resend-Idempotency-Key: tagmails-status-${jobId}-${status}`,
    'MIME-Version: 1.0', `Content-Type: multipart/alternative; boundary="${boundary}"`, '',
    `--${boundary}`, 'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit', '', selected.text,
    `--${boundary}`, 'Content-Type: text/vnd.google.email-reaction+json; charset=UTF-8',
    'Content-Transfer-Encoding: base64', '', reaction,
    `--${boundary}`, 'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: 7bit', '', `<p>${selected.text}</p>`,
    `--${boundary}--`, '',
  ].join('\r\n');
  return { from, to, raw };
}
