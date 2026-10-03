import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { accountPage } from './account-page.mjs';

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
  assert.ok(command.includes("--relay 'https://relay.test'"));
  assert.match(command, /scripts\/install-macos-launchagent\.mjs/);
  assert.match(command, /--workspace-access read/);
});

test('account setup makes write access an explicit command choice', async () => {
  const html = await accountPage().text();
  const script = html.match(/<script nonce="[^"]+" defer>([\s\S]*?)<\/script>/)?.[1];
  const command = vm.runInNewContext(`${script}\ninstallCommand()`, {
    document: { getElementById: (id) => ({ value: id === 'workspaceAccess' ? 'write' : '/tmp/scratch' }),
      addEventListener: () => {} },
    location: { origin: 'https://relay.test' },
  });
  assert.match(command, /--workspace-access write/);
});
