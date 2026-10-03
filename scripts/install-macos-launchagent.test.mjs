import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('LaunchAgent preview defaults to read-only and keeps broader access explicit', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-launchagent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'workspace');
  const binary = path.join(root, 'daemon');
  const token = path.join(root, 'token');
  fs.mkdirSync(workspace);
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  fs.writeFileSync(token, `tm_dev_${'a'.repeat(43)}\n`, { mode: 0o600 });
  const args = ['scripts/install-macos-launchagent.mjs', '--relay', 'https://relay.example',
    '--workspace', workspace, '--token-file', token, '--bin', binary, '--print'];
  const preview = (extra = []) => spawnSync(process.execPath, [...args, ...extra], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8',
  });
  const read = preview();
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /<key>TAGMAILS_WORKSPACE_ACCESS<\/key><string>read<\/string>/);
  if (process.platform === 'darwin') {
    const plist = path.join(root, 'com.tagmails.daemon.plist');
    fs.writeFileSync(plist, read.stdout);
    const lint = spawnSync('plutil', ['-lint', plist], { encoding: 'utf8' });
    assert.equal(lint.status, 0, lint.stderr || lint.stdout);
  }
  const write = preview(['--workspace-access', 'write']);
  assert.equal(write.status, 0, write.stderr);
  assert.match(write.stdout, /<key>TAGMAILS_WORKSPACE_ACCESS<\/key><string>write<\/string>/);
  const full = preview(['--workspace-access', 'full']);
  assert.equal(full.status, 0, full.stderr);
  assert.match(full.stdout, /<key>TAGMAILS_WORKSPACE_ACCESS<\/key><string>full<\/string>/);
  const invalid = preview(['--workspace-access', 'all']);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /Workspace access must be read, write, or full/);
});
