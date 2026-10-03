import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { handleInbound } from './relay-worker.mjs';

function bindings() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(new URL('./migrations/0001_inbound.sql', import.meta.url), 'utf8'));
  sqlite.prepare('INSERT INTO accounts (id, google_sub, owner_email, agent_email) VALUES (?, ?, ?, ?)')
    .run('account-1', 'google-sub-1', 'owner@gmail.com', 'agent@wonder.test');
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          const statement = sqlite.prepare(sql);
          return { first: async () => statement.get(...args) ?? null, run: async () => statement.run(...args) };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const objects = new Map();
  const env = {
    DB: db, MAIL: { put: async (key, value) => objects.set(key, Buffer.from(value)) },
    RESEND_API_KEY: 're_test', RESEND_WEBHOOK_SECRET: 'whsec_test', AGENT_ADDRESS: 'agent@wonder.test',
  };
  return { env, sqlite, objects };
}

function mail(providerEmailId, from, overrides = {}) {
  return {
    providerEmailId, eventId: `event-${providerEmailId}`, messageId: `<${providerEmailId}@gmail.com>`,
    from, to: ['agent@wonder.test'], cc: [], bcc: [], subject: 'Shared work', body: 'Review this.',
    parentIds: [], attachments: [], rawMime: Buffer.from(`From: ${from}\r\nMessage-ID: <${providerEmailId}@gmail.com>\r\n`),
    ...overrides,
  };
}

async function deliver(env, message) {
  const request = new Request('https://relay.example/webhooks/resend', { method: 'POST', body: '{}' });
  const response = await handleInbound(request, env, { inspect: async () => message });
  assert.equal(response.status, 200);
  return response.json();
}

test('verified ingress stores one durable job, deduplicates, and grants only visible owner recipients', async () => {
  const { env, sqlite, objects } = bindings();
  const first = mail('email-1', 'owner@gmail.com', {
    to: ['agent@wonder.test', 'reviewer@gmail.com'], bcc: ['hidden@gmail.com'],
  });
  assert.deepEqual(await deliver(env, first), { accepted: true, duplicate: false });
  assert.deepEqual(await deliver(env, first), { accepted: true, duplicate: true });
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM messages').get().n, 1);
  assert.deepEqual(sqlite.prepare('SELECT email FROM participants').all().map((row) => row.email), ['reviewer@gmail.com']);
  assert.equal(objects.size, 1);
  assert.deepEqual(objects.get('inbound/account-1/email-1.eml'), first.rawMime);
});

test('only an owner-granted participant can continue the thread and guests cannot add others', async () => {
  const { env, sqlite, objects } = bindings();
  const first = mail('email-1', 'owner@gmail.com', { cc: ['reviewer@gmail.com'] });
  await deliver(env, first);
  assert.deepEqual(await deliver(env, mail('email-2', 'stranger@gmail.com')), { accepted: false });
  assert.deepEqual(await deliver(env, mail('email-3', 'stranger@gmail.com', { parentIds: [first.messageId] })), { accepted: false });
  assert.deepEqual(await deliver(env, mail('email-4', 'reviewer@gmail.com', {
    parentIds: [first.messageId], cc: ['stranger@gmail.com'],
  })), { accepted: true, duplicate: false });
  assert.equal(sqlite.prepare('SELECT count(*) n FROM threads').get().n, 1);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 2);
  assert.deepEqual(sqlite.prepare('SELECT email FROM participants').all().map((row) => row.email), ['reviewer@gmail.com']);
  assert.equal(objects.size, 2);
  sqlite.prepare('UPDATE participants SET revoked_at = CURRENT_TIMESTAMP WHERE email = ?').run('reviewer@gmail.com');
  assert.deepEqual(await deliver(env, mail('email-5', 'reviewer@gmail.com', { parentIds: [first.messageId] })), { accepted: false });
});

test('Gmail reaction mail never creates an agent job', async () => {
  const { env, sqlite } = bindings();
  const first = mail('email-1', 'owner@gmail.com');
  await deliver(env, first);
  assert.deepEqual(await deliver(env, mail('email-2', 'owner@gmail.com', {
    parentIds: [first.messageId], reaction: '👍', reactionTargetId: first.messageId,
  })), { accepted: false, reaction: true });
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 1);
});

test('R2 failure leaves no job and a later delivery can be retried', async () => {
  const { env, sqlite } = bindings();
  const originalPut = env.MAIL.put;
  env.MAIL.put = async () => { throw new Error('R2 unavailable'); };
  const message = mail('email-1', 'owner@gmail.com');
  const request = new Request('https://relay.example/webhooks/resend', { method: 'POST', body: '{}' });
  await assert.rejects(handleInbound(request, env, { inspect: async () => message }), /R2 unavailable/);
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 0);
  env.MAIL.put = originalPut;
  assert.deepEqual(await deliver(env, message), { accepted: true, duplicate: false });
  assert.equal(sqlite.prepare('SELECT count(*) n FROM jobs').get().n, 1);
});
