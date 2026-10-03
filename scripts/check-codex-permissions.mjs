import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CODEX_CONFIG, PROFILE } from '../apps/mock-inbox/codex-profile.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagmails-permissions-'));
const workspace = path.join(root, 'workspace');
const home = path.join(root, 'codex-home');
const outside = path.join(root, 'outside.txt');
fs.mkdirSync(workspace);
fs.mkdirSync(home);
fs.writeFileSync(path.join(workspace, 'inside.txt'), 'synthetic inside marker\n');
fs.writeFileSync(outside, 'synthetic outside marker\n');
fs.symlinkSync(outside, path.join(workspace, 'outside-link.txt'));
fs.writeFileSync(path.join(home, 'config.toml'), CODEX_CONFIG);

function sandbox(command) {
  return spawnSync(process.env.TAGMAILS_CODEX_BIN || 'codex',
    ['sandbox', '-P', PROFILE, '-C', workspace, ...command],
    { cwd: workspace, env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 10_000 });
}

try {
  const inside = sandbox(['cat', path.join(workspace, 'inside.txt')]);
  assert.equal(inside.status, 0, inside.stderr);
  assert.match(inside.stdout, /synthetic inside marker/);

  const insideWrite = sandbox(['sh', '-c', 'printf forbidden > new-inside.txt']);
  assert.notEqual(insideWrite.status, 0, 'A workspace file was writable');
  assert.equal(fs.existsSync(path.join(workspace, 'new-inside.txt')), false);

  const outsideRead = sandbox(['cat', outside]);
  assert.notEqual(outsideRead.status, 0, 'An outside file was readable');
  assert.equal(outsideRead.stdout.includes('synthetic outside marker'), false);

  const outsideLinkRead = sandbox(['cat', path.join(workspace, 'outside-link.txt')]);
  assert.notEqual(outsideLinkRead.status, 0, 'An outside file was readable through a workspace symlink');
  assert.equal(outsideLinkRead.stdout.includes('synthetic outside marker'), false);

  const outsideWrite = sandbox(['sh', '-c', 'printf forbidden > "$1"', 'sh', path.join(root, 'new-outside.txt')]);
  assert.notEqual(outsideWrite.status, 0, 'An outside file was writable');
  assert.equal(fs.existsSync(path.join(root, 'new-outside.txt')), false);

  const auth = path.join(os.homedir(), '.codex', 'auth.json');
  if (fs.existsSync(auth)) {
    const authRead = sandbox(['test', '-r', auth]);
    assert.notEqual(authRead.status, 0, 'Codex authentication was readable from the sandbox');
  }
  console.log('Codex permission preflight passed: workspace read allowed; workspace write, outside read/write, symlink escape, and auth read denied.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
