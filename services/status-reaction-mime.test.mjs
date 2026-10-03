import assert from 'node:assert/strict';
import test from 'node:test';
import PostalMime from 'postal-mime';
import { buildStatusReaction } from './status-reaction-mime.mjs';

const base = { jobId: '11111111-1111-4111-8111-111111111111',
  from: 'agent@tagmails.com', to: 'owner@gmail.com', targetMessageId: '<original@gmail.com>',
  subject: 'Résumé review' };

test('status reactions produce Gmail-compatible MIME tied to the original email', async () => {
  for (const [status, emoji] of [['received', '👀'], ['working', '📝'],
    ['completed', '✅'], ['failed', '⚠️']]) {
    const { raw } = buildStatusReaction({ ...base, status });
    const parsed = await new PostalMime().parse(raw);
    assert.equal(parsed.inReplyTo, base.targetMessageId);
    assert.equal(parsed.subject, 'Re: Résumé review');
    assert.equal(parsed.to[0].address, base.to);
    assert.match(parsed.text, /TagMails/);
    assert.match(parsed.html, /<p>TagMails/);
    const part = parsed.attachments.find((item) => item.mimeType === 'text/vnd.google.email-reaction+json');
    assert.ok(part);
    assert.deepEqual(JSON.parse(Buffer.from(part.content).toString()), { version: 1, emoji });
    assert.match(raw, /Resend-Idempotency-Key: tagmails-status-/);
  }
});

test('status MIME rejects recipient and thread-header injection', () => {
  assert.throws(() => buildStatusReaction({ ...base, status: 'received',
    to: 'owner@gmail.com\r\nBcc: stranger@example.com' }), /Invalid status reaction/);
  assert.throws(() => buildStatusReaction({ ...base, status: 'received',
    targetMessageId: '<original@gmail.com>\r\nBcc: stranger@example.com' }), /Invalid status reaction/);
  const safe = buildStatusReaction({ ...base, status: 'received', subject: 'Hi\r\nBcc: stranger@example.com' });
  assert.ok(!safe.raw.includes('\r\nBcc:'));
});
