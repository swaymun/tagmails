import assert from 'node:assert/strict';
import test from 'node:test';
import { sendRawResendEmail } from './resend-smtp.mjs';

function fakeSmtp({ rejectAuth = false } = {}) {
  const writes = [];
  let controller;
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const readable = new ReadableStream({ start(value) {
    controller = value;
    value.enqueue(encoder.encode('220 smtp.resend.com ready\r\n'));
  } });
  const writable = new WritableStream({ write(chunk) {
    const value = decoder.decode(chunk);
    writes.push(value);
    const reply = value.startsWith('EHLO ') ? '250-smtp.resend.com\r\n250 AUTH PLAIN\r\n'
      : value.startsWith('AUTH ') ? rejectAuth ? '535 Authentication failed\r\n' : '235 Accepted\r\n'
      : value.startsWith('MAIL FROM:') || value.startsWith('RCPT TO:') ? '250 OK\r\n'
      : value === 'DATA\r\n' ? '354 Continue\r\n'
      : value.startsWith('QUIT') ? '221 Bye\r\n' : '250 Queued\r\n';
    controller.enqueue(encoder.encode(reply));
  } });
  return { writes, connect: (address, options) => {
    assert.deepEqual(address, { hostname: 'smtp.resend.com', port: 465 });
    assert.deepEqual(options, { secureTransport: 'on' });
    return { opened: Promise.resolve(), readable, writable, close() { controller.close(); } };
  } };
}

test('raw status MIME uses TLS SMTP and dot-stuffs the DATA body', async () => {
  const server = fakeSmtp();
  const result = await sendRawResendEmail({ from: 'agent@tagmails.com', to: 'owner@gmail.com',
    raw: 'From: agent@tagmails.com\r\nTo: owner@gmail.com\r\n\r\n.hello\r\n',
    apiKey: 're_test_key', connect: server.connect });
  assert.deepEqual(result, { accepted: true });
  assert.ok(server.writes[1].startsWith('AUTH PLAIN '));
  assert.match(server.writes.find((part) => part.includes('..hello')), /\r\n\.\.hello\r\n\.\r\n$/);
});

test('SMTP authentication rejection stops before sender or DATA commands', async () => {
  const server = fakeSmtp({ rejectAuth: true });
  await assert.rejects(sendRawResendEmail({ from: 'agent@tagmails.com', to: 'owner@gmail.com',
    raw: 'Subject: test\r\n\r\nHi', apiKey: 're_test_key', connect: server.connect }), /535/);
  assert.equal(server.writes.length, 2);
});
