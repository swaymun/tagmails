import fs from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const PROFILE = 'tagmails-read';
export const WRITE_PROFILE = 'tagmails-write';
export const FULL_PROFILE = ':danger-full-access';

function codexConfig(profile, access) {
  return `web_search = "disabled"
default_permissions = "${profile}"
approval_policy = "on-request"

[permissions.${profile}]
extends = ":read-only"

[permissions.${profile}.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"
":slash_tmp" = "deny"

[permissions.${profile}.filesystem.":workspace_roots"]
"." = "${access}"

[permissions.${profile}.network]
enabled = false
`;
}

export const CODEX_CONFIG = codexConfig(PROFILE, 'read');
export const WRITE_CODEX_CONFIG = codexConfig(WRITE_PROFILE, 'write');
export const FULL_CODEX_CONFIG = `web_search = "disabled"\ndefault_permissions = "${FULL_PROFILE}"\napproval_policy = "never"\n`;

function overlaps(a, b) {
  const relative = path.relative(a, b);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Codex records a trust decision for each project it runs in by appending
// `[projects."<path>"] trust_level = ...` to this config. Accept exactly
// those additions; any other change still stops the run.
const TRUST_BLOCK = /\n*\[projects\.("(?:[^"\\\n]|\\.)*")\]\ntrust_level = "(?:trusted|untrusted)"\n?/g;

export function sameConfig(actual, expected) {
  if (actual === expected) return true;
  const base = (text) => text.replace(TRUST_BLOCK, '\n').replace(/\n+$/, '\n');
  return base(actual) === base(expected);
}

export async function prepareCodexProfile(workspace, access = false) {
  const full = access === 'full';
  const write = access === true || access === 'write';
  let project = workspace;
  if (full) {
    try { project = execFileSync('git', ['-C', workspace, 'rev-parse', '--show-toplevel'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || workspace; }
    catch { /* A non-Git workspace is its own trust boundary. */ }
  }
  const config = full ? `${FULL_CODEX_CONFIG}\n[projects.${JSON.stringify(project)}]\ntrust_level = "trusted"\n`
    : write ? WRITE_CODEX_CONFIG : CODEX_CONFIG;
  const source = process.env.TAGMAILS_CODEX_AUTH_FILE ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const destination = process.env.TAGMAILS_CODEX_RUNTIME_HOME ||
    path.join(os.homedir(), '.tagmails', full ? 'codex-full' : write ? 'codex-write' : 'codex-readonly');
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) throw new Error('Codex auth and runtime home must be absolute paths');
  const auth = await fs.realpath(source);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const home = await fs.realpath(destination);
  if (overlaps(workspace, home) || overlaps(home, workspace) ||
      overlaps(workspace, auth) || overlaps(auth, workspace)) {
    throw new Error('Codex authentication and runtime home must be outside the selected workspace');
  }
  const configFile = path.join(home, 'config.toml');
  try { await fs.writeFile(configFile, config, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (!sameConfig(await fs.readFile(configFile, 'utf8'), config)) throw new Error('Codex runtime configuration was changed');
  const authLink = path.join(home, 'auth.json');
  try { await fs.symlink(auth, authLink); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (await fs.realpath(authLink) !== auth) throw new Error('Codex runtime authentication link was changed');
  return home;
}

// Owner turns run like Wonder does: a TagMails-only Codex home (its own
// sessions and history) that links the owner's Codex config, sign-in,
// plugins, skills and rules, so their connectors (Google Drive, Gmail, ...)
// work. The permission profile arrives as -c overrides on each run instead of
// a config file, and desktop control stays off.
const SHARED = ['config.toml', 'auth.json', '.credentials.json', 'plugins', 'skills', 'rules'];

function profileOverride(profile, access) {
  return `permissions.${profile}={extends=":read-only",filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny",":workspace_roots"={"."="${access}"}},network={enabled=false}}`;
}

export function ownerOverrides(access) {
  // Inline table: Codex ignores dotted -c keys with quoted plugin names, and
  // session flags merge into the owner's plugin table rather than replace it.
  const values = ['notify=[]',
    'plugins={"unified-computer-use@openai-bundled"={enabled=false},"computer-use@openai-bundled"={enabled=false}}'];
  if (access !== 'full') {
    const write = access === true || access === 'write';
    values.push(profileOverride(write ? WRITE_PROFILE : PROFILE, write ? 'write' : 'read'));
  }
  return values.flatMap((value) => ['-c', value]);
}

export async function prepareOwnerCodexHome(workspace, access = false) {
  const full = access === 'full';
  const write = access === true || access === 'write';
  const desktop = process.env.TAGMAILS_CODEX_DESKTOP_HOME || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const destination = process.env.TAGMAILS_CODEX_OWNER_HOME ||
    path.join(os.homedir(), '.tagmails', full ? 'codex-owner-full' : write ? 'codex-owner-write' : 'codex-owner-readonly');
  if (!path.isAbsolute(desktop) || !path.isAbsolute(destination)) throw new Error('Codex homes must be absolute paths');
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const home = await fs.realpath(destination);
  const source = await fs.realpath(desktop);
  for (const root of [home, source]) {
    if (overlaps(workspace, root) || overlaps(root, workspace)) {
      throw new Error('Codex homes must be outside the selected workspace');
    }
  }
  for (const name of SHARED) {
    const from = path.join(source, name);
    const to = path.join(home, name);
    try { await fs.access(from); } catch { continue; }
    try { await fs.lstat(to); } catch { await fs.symlink(from, to); }
  }
  return { home, args: ownerOverrides(full ? 'full' : write) };
}
