import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PROFILE = 'tagmails-read';
export const WRITE_PROFILE = 'tagmails-write';

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

function overlaps(a, b) {
  const relative = path.relative(a, b);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function prepareCodexProfile(workspace, write = false) {
  const config = write ? WRITE_CODEX_CONFIG : CODEX_CONFIG;
  const source = process.env.TAGMAILS_CODEX_AUTH_FILE ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const destination = process.env.TAGMAILS_CODEX_RUNTIME_HOME ||
    path.join(os.homedir(), '.tagmails', write ? 'codex-write' : 'codex-readonly');
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
  if (await fs.readFile(configFile, 'utf8') !== config) throw new Error('Codex runtime configuration was changed');
  const authLink = path.join(home, 'auth.json');
  try { await fs.symlink(auth, authLink); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (await fs.realpath(authLink) !== auth) throw new Error('Codex runtime authentication link was changed');
  return home;
}
