import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { accountPage, runReceiptPage } from './account-page.mjs';

test('account setup generates a shell-quoted workspace command', async () => {
  const html = await accountPage().text();
  const script = html.match(/<script nonce="[^"]+" defer>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  const command = vm.runInNewContext(`${script}\ninstallCommand()`, {
    document: {
      getElementById: (id) => ({ value: id === 'workspaceAccess' ? 'read' : "/tmp/O'Neil;$(false)" }),
      addEventListener: () => {},
    },
    location: { origin: 'https://relay.test' },
  });
  assert.ok(command.includes("--workspace '/tmp/O'\\''Neil;$(false)'"));
  assert.match(command, /^tagmails start --access read --workspace /);
});

test('account setup makes write access an explicit command choice', async () => {
  const html = await accountPage().text();
  const script = html.match(/<script nonce="[^"]+" defer>([\s\S]*?)<\/script>/)?.[1];
  const command = vm.runInNewContext(`${script}\ninstallCommand()`, {
    document: { getElementById: (id) => ({ value: id === 'workspaceAccess' ? 'write' : '/tmp/scratch' }),
      addEventListener: () => {} },
    location: { origin: 'https://relay.test' },
  });
  assert.match(command, /--access write/);
});

test('run receipt distinguishes provider acceptance from inbox delivery', async () => {
  const run = { id: 'run-1', subject: 'Review draft', state: 'completed', attempts: 1,
    sender_email: 'owner@gmail.com', created_at: '2026-10-03 10:00:00',
    result: { summary: 'Draft reviewed.' }, delivery_state: 'accepted' };
  const accepted = await runReceiptPage(run).text();
  assert.match(accepted, /waiting for its Message-ID/);
  assert.match(accepted, /inbox delivery is not confirmed/);
  const blocked = await runReceiptPage({ ...run, delivery_state: 'blocked' }).text();
  assert.match(blocked, /stopped before sending.*will not be retried automatically/);
});
