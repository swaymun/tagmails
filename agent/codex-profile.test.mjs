import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { prepareCodexProfile, sameConfig, WRITE_CODEX_CONFIG } from './codex-profile.mjs';

test('the runtime config accepts project trust that Codex records, and nothing else', () => {
  const trusted = `${WRITE_CODEX_CONFIG}\n[projects."/Users/me/code/travel-guides"]\ntrust_level = "trusted"\n`;
  assert.equal(sameConfig(trusted, WRITE_CODEX_CONFIG), true);
  assert.equal(sameConfig(`${trusted}\n[projects."/Users/me/other"]\ntrust_level = "untrusted"\n`, WRITE_CODEX_CONFIG), true);
  assert.equal(sameConfig(WRITE_CODEX_CONFIG.replace('enabled = false', 'enabled = true'), WRITE_CODEX_CONFIG), false);
  assert.equal(sameConfig(`${trusted}sandbox_mode = "danger-full-access"\n`, WRITE_CODEX_CONFIG), false);
  assert.equal(sameConfig(`${WRITE_CODEX_CONFIG}\n[projects."/x"]\ntrust_level = "trusted"\napproval_policy = "never"\n`, WRITE_CODEX_CONFIG), false);
});

test('a second run in a project Codex already trusted still prepares the profile', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tagmails-profile-'));
  const workspace = path.join(root, 'project');
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(root, 'auth.json'), '{}');
  process.env.TAGMAILS_CODEX_AUTH_FILE = path.join(root, 'auth.json');
  process.env.TAGMAILS_CODEX_RUNTIME_HOME = path.join(root, 'home');
  try {
    const home = await prepareCodexProfile(workspace, 'write');
    await fs.appendFile(path.join(home, 'config.toml'), `\n[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`);
    assert.equal(await prepareCodexProfile(workspace, 'write'), home);
    await fs.appendFile(path.join(home, 'config.toml'), 'web_search = "live"\n');
    await assert.rejects(prepareCodexProfile(workspace, 'write'), /configuration was changed/);
  } finally {
    delete process.env.TAGMAILS_CODEX_AUTH_FILE;
    delete process.env.TAGMAILS_CODEX_RUNTIME_HOME;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('an owner run links the owner Codex setup and passes its permission profile as overrides', async () => {
  const { prepareOwnerCodexHome } = await import('./codex-profile.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tagmails-owner-'));
  const desktop = path.join(root, 'desktop');
  const workspace = path.join(root, 'project');
  await fs.mkdir(path.join(desktop, 'plugins'), { recursive: true });
  await fs.mkdir(path.join(desktop, 'sessions'), { recursive: true });
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(desktop, 'config.toml'), '[plugins."google-drive@openai-curated"]\nenabled = true\n');
  await fs.writeFile(path.join(desktop, 'auth.json'), '{}');
  process.env.TAGMAILS_CODEX_DESKTOP_HOME = desktop;
  process.env.TAGMAILS_CODEX_OWNER_HOME = path.join(root, 'owner');
  try {
    const { home, args } = await prepareOwnerCodexHome(workspace, 'write');
    assert.equal((await fs.lstat(path.join(home, 'config.toml'))).isSymbolicLink(), true);
    assert.equal((await fs.lstat(path.join(home, 'plugins'))).isSymbolicLink(), true);
    await assert.rejects(fs.lstat(path.join(home, 'sessions')), /ENOENT/);
    const overrides = args.filter((_, index) => index % 2 === 1);
    assert.ok(overrides.some((value) => value.startsWith('permissions.tagmails-write={') && value.includes('"."="write"') && value.includes('network={enabled=false}')));
    assert.ok(overrides.some((value) => value.startsWith('plugins={') && value.includes('"computer-use@openai-bundled"={enabled=false}')));
    assert.ok(overrides.includes('notify=[]'));
    assert.equal((await prepareOwnerCodexHome(workspace, 'write')).home, home);
    await assert.rejects(prepareOwnerCodexHome(await fs.realpath(desktop), 'write'), /outside the selected workspace/);
  } finally {
    delete process.env.TAGMAILS_CODEX_DESKTOP_HOME;
    delete process.env.TAGMAILS_CODEX_OWNER_HOME;
    await fs.rm(root, { recursive: true, force: true });
  }
});
