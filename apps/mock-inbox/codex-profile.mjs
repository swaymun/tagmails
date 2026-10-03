import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const PROFILE = 'tagmails-read';

export const CODEX_CONFIG = `web_search = "disabled"
default_permissions = "${PROFILE}"
approval_policy = "on-request"

[permissions.${PROFILE}]
extends = ":read-only"

[permissions.${PROFILE}.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"
":slash_tmp" = "deny"

[permissions.${PROFILE}.filesystem.":workspace_roots"]
"." = "read"

[permissions.${PROFILE}.network]
enabled = false
`;

function overlaps(a, b) {
  const relative = path.relative(a, b);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export async function prepareCodexProfile(workspace) {
  const source = process.env.TAGMAILS_CODEX_AUTH_FILE ||
    path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
  const destination = process.env.TAGMAILS_CODEX_RUNTIME_HOME ||
    path.join(os.homedir(), '.tagmails', 'codex-readonly');
  if (!path.isAbsolute(source) || !path.isAbsolute(destination)) throw new Error('Codex auth and runtime home must be absolute paths');
  const auth = await fs.realpath(source);
  await fs.mkdir(destination, { recursive: true, mode: 0o700 });
  const home = await fs.realpath(destination);
  if (overlaps(workspace, home) || overlaps(home, workspace) ||
      overlaps(workspace, auth) || overlaps(auth, workspace)) {
    throw new Error('Codex authentication and runtime home must be outside the selected workspace');
  }
  const configFile = path.join(home, 'config.toml');
  try { await fs.writeFile(configFile, CODEX_CONFIG, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (await fs.readFile(configFile, 'utf8') !== CODEX_CONFIG) throw new Error('Codex runtime configuration was changed');
  const authLink = path.join(home, 'auth.json');
  try { await fs.symlink(auth, authLink); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (await fs.realpath(authLink) !== auth) throw new Error('Codex runtime authentication link was changed');
  return home;
}
