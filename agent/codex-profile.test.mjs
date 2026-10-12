import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { deviceSecretFiles, ownerOverrides, prepareCodexProfile, sameConfig, WRITE_CODEX_CONFIG } from './codex-profile.mjs';

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

test('an owner run uses the owner Codex home and passes its permission profile as overrides', async () => {
  const { prepareOwnerCodexHome } = await import('./codex-profile.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tagmails-owner-'));
  const desktop = path.join(root, 'desktop');
  const workspace = path.join(root, 'project');
  await fs.mkdir(desktop, { recursive: true });
  await fs.mkdir(workspace);
  process.env.TAGMAILS_CODEX_DESKTOP_HOME = desktop;
  process.env.TAGMAILS_CODEX_OWNER_HOME = path.join(root, 'store');
  try {
    const { home, storeDir, args } = await prepareOwnerCodexHome(workspace, 'write');
    assert.equal(home, await fs.realpath(desktop));
    assert.equal(storeDir, await fs.realpath(path.join(root, 'store')));
    const overrides = args.filter((_, index) => index % 2 === 1);
    assert.ok(overrides.some((value) => value.startsWith('permissions.tagmails-write={') && value.includes('"."="write"') && value.includes('":root"="read"') && value.includes('".git"="write"') && value.includes('network={enabled=true}')));
    assert.ok(overrides.some((value) => value.startsWith('plugins={') && value.includes('"computer-use@openai-bundled"={enabled=false}')));
    assert.ok(overrides.includes('notify=[]'));
    await assert.rejects(prepareOwnerCodexHome(await fs.realpath(desktop), 'write'), /outside the selected workspace/);
  } finally {
    delete process.env.TAGMAILS_CODEX_DESKTOP_HOME;
    delete process.env.TAGMAILS_CODEX_OWNER_HOME;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('owner write turns in a repository subfolder may write that repository\'s git folder', async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'tagmails-subrepo-')));
  try {
    execFileSync('git', ['init', '-q', root]);
    await fs.mkdir(path.join(root, 'app'));
    const override = ownerOverrides('write', path.join(root, 'app')).find((value) => value.startsWith('permissions.'));
    assert.ok(override.includes(`${JSON.stringify(path.join(root, '.git'))}="write"`));
    const atRoot = ownerOverrides('write', root).find((value) => value.startsWith('permissions.'));
    assert.ok(!atRoot.includes(JSON.stringify(path.join(root, '.git'))));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('owner write turns may change Tagmails model defaults, never config.json, and only owner turns get that folder', () => {
  const settings = JSON.stringify(path.join(os.homedir(), '.config', 'tagmails', 'email'));
  const env = { ...process.env };
  delete process.env.TAGMAILS_CONFIG_DIR; delete process.env.XDG_CONFIG_HOME;
  try {
    const write = ownerOverrides('write').find((value) => value.startsWith('permissions.'));
    assert.ok(write.includes(`${settings}="write"`));
    assert.ok(!write.includes(`${JSON.stringify(path.join(os.homedir(), '.config', 'tagmails'))}="write"`));
    const read = ownerOverrides(false).find((value) => value.startsWith('permissions.'));
    assert.ok(!read.includes(settings));
    assert.ok(!WRITE_CODEX_CONFIG.includes('tagmails"'), 'participant write turns never get the settings folder');
  } finally { Object.assign(process.env, env); }
});

test('owner write turns read the whole Mac except the Tagmails device token and sealing key', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tagmails-token-deny-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { ...process.env };
  t.after(() => { for (const key of ['TAGMAILS_CONFIG_DIR', 'TAGMAILS_DEVICE_TOKEN_FILE']) delete process.env[key]; Object.assign(process.env, env); });
  process.env.TAGMAILS_CONFIG_DIR = path.join(root, 'config');
  process.env.TAGMAILS_DEVICE_TOKEN_FILE = path.join(root, 'elsewhere', 'device-token');
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  await fs.mkdir(path.join(root, 'config'));
  await fs.mkdir(path.join(root, 'elsewhere'));
  for (const file of deviceSecretFiles()) await fs.writeFile(file, 'tm_dev_secret\n');
  await fs.writeFile(path.join(root, 'config', 'config.json'), 'readable\n');
  const write = ownerOverrides('write', workspace).find((value) => value.startsWith('permissions.'));
  assert.deepEqual(deviceSecretFiles(), [path.join(root, 'config', 'device-token'), path.join(root, 'config', 'device-key'),
    path.join(root, 'elsewhere', 'device-token')]);
  for (const file of deviceSecretFiles()) assert.ok(write.includes(`${JSON.stringify(file)}="deny"`), file);
  // The real sandbox, when Codex is installed: the token is unreadable, the rest of the Mac is not.
  const codex = process.env.TAGMAILS_CODEX_BIN || 'codex';
  const home = path.join(root, 'codex-home');
  await fs.mkdir(home);
  const run = (file) => spawnSync(codex, ['sandbox', '-P', 'tagmails-write', '-c', write, '-C', workspace, 'cat', file],
    { cwd: workspace, env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 20_000 });
  const probe = run(path.join(root, 'config', 'config.json'));
  if (probe.error?.code === 'ENOENT') return t.skip('codex is not installed');
  assert.equal(probe.stdout, 'readable\n', probe.stderr);
  for (const file of deviceSecretFiles()) assert.doesNotMatch(run(file).stdout, /tm_dev_secret/, file);
});
