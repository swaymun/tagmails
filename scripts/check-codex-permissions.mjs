import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-permissions-'));
const workspace = path.join(root, 'workspace');
const home = path.join(root, 'codex-home');
const outside = path.join(root, 'outside.txt');
fs.mkdirSync(workspace);
fs.mkdirSync(home);
fs.writeFileSync(outside, 'synthetic outside marker\n');
fs.writeFileSync(path.join(home, 'config.toml'), `default_permissions = "workspace-only"

[permissions.workspace-only]
extends = ":workspace"

[permissions.workspace-only.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"
":slash_tmp" = "deny"

[permissions.workspace-only.network]
enabled = false
`);

function sandbox(command) {
  return spawnSync(process.env.TAGMAILS_CODEX_BIN || 'codex',
    ['sandbox', '-P', 'workspace-only', '-C', workspace, ...command],
    { cwd: workspace, env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 10_000 });
}

try {
  const inside = sandbox(['sh', '-c', 'printf allowed > inside.txt']);
  assert.equal(inside.status, 0, inside.stderr);
  assert.equal(fs.readFileSync(path.join(workspace, 'inside.txt'), 'utf8'), 'allowed');

  const outsideRead = sandbox(['cat', outside]);
  assert.notEqual(outsideRead.status, 0, 'An outside file was readable');
  assert.equal(outsideRead.stdout.includes('synthetic outside marker'), false);

  const outsideWrite = sandbox(['sh', '-c', 'printf forbidden > "$1"', 'sh', path.join(root, 'new-outside.txt')]);
  assert.notEqual(outsideWrite.status, 0, 'An outside file was writable');
  assert.equal(fs.existsSync(path.join(root, 'new-outside.txt')), false);

  const auth = path.join(os.homedir(), '.codex', 'auth.json');
  if (fs.existsSync(auth)) {
    const authRead = sandbox(['test', '-r', auth]);
    assert.notEqual(authRead.status, 0, 'Codex authentication was readable from the sandbox');
  }
  console.log('Codex permission preflight passed: workspace write allowed; outside read, outside write, and auth read denied.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
