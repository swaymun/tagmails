// Lists this machine's recent Codex and Claude Code project folders so the
// relay can route a new email to the right one. Only folder names, paths,
// branch names and a short README excerpt leave the machine.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

export const MAX_PROJECTS = 40;
const DESCRIPTION_CHARS = 900;

async function codexProjects(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  const child = spawn(process.env.TAGMAILS_CODEX_BIN || 'codex', ['app-server'], {
    env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'ignore'],
  });
  child.stdin.on('error', () => {});
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  const fail = (error) => { for (const target of pending.values()) target.reject(error); pending.clear(); };
  child.once('error', fail);
  child.once('close', () => fail(new Error('Codex app-server exited')));
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.id === undefined) return;
    if (message.method) {
      child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: 'Not supported' } })}\n`);
      return;
    }
    const target = pending.get(message.id);
    if (!target) return;
    pending.delete(message.id);
    if (message.error) target.reject(new Error(message.error.message || 'Codex request failed'));
    else target.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const timer = setTimeout(() => { fail(new Error('Codex project list timed out')); child.kill(); }, 10_000);
  try {
    await request('initialize', { clientInfo: { name: 'tagmails', title: 'TagMails', version: '0.2.0' },
      capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const list = await request('project/list', { limit: 100 });
    return (list?.data ?? []).flatMap((project) => (project.roots ?? []).map((root) => ({
      path: root.path, name: project.roots.length > 1 ? path.basename(root.path) : project.name,
      projectName: project.name, recencyAt: (project.recencyAt ?? project.updatedAt ?? 0) * 1000, source: 'codex',
    })));
  } finally { clearTimeout(timer); child.kill(); lines.close(); }
}

async function firstCwd(file) {
  const handle = await fs.open(file);
  try {
    const lines = readline.createInterface({ input: handle.createReadStream({ end: 256 * 1024 }) });
    let count = 0;
    for await (const line of lines) {
      if (++count > 200) break;
      try {
        const entry = JSON.parse(line);
        if (typeof entry.cwd === 'string') return entry.cwd;
      } catch { /* Skip partial lines. */ }
    }
  } finally { await handle.close(); }
  return null;
}

async function claudeProjects(root = path.join(os.homedir(), '.claude/projects')) {
  let folders;
  try { folders = await fs.readdir(root, { withFileTypes: true }); } catch { return []; }
  const sessions = [];
  for (const folder of folders.filter((entry) => entry.isDirectory())) {
    const dir = path.join(root, folder.name);
    for (const name of (await fs.readdir(dir).catch(() => [])).filter((file) => file.endsWith('.jsonl'))) {
      const file = path.join(dir, name);
      const stat = await fs.stat(file).catch(() => null);
      if (stat) sessions.push({ file, folder: folder.name, mtime: stat.mtimeMs });
    }
  }
  sessions.sort((a, b) => b.mtime - a.mtime);
  const seen = new Map();
  for (const session of sessions) {
    if (seen.has(session.folder)) continue;
    if (seen.size >= MAX_PROJECTS) break;
    const cwd = await firstCwd(session.file).catch(() => null);
    if (cwd) seen.set(session.folder, { path: cwd, name: path.basename(cwd), recencyAt: session.mtime, source: 'claude' });
  }
  return [...seen.values()];
}

const MARKERS = ['.git', 'README.md', 'README', 'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod'];

async function looksLikeProject(folder) {
  for (const marker of MARKERS) if (await fs.stat(path.join(folder, marker)).catch(() => null)) return true;
  return false;
}

export function excluded(folder, home = os.homedir()) {
  // Hidden folders (.local, .cache, worktrees) hold tool scratch, not projects.
  if (path.relative(home, folder).split(path.sep).some((part) => part.startsWith('.'))) return true;
  const blocked = [path.join(home, '.tagmails'), path.join(home, '.codex'), path.join(home, '.claude'),
    path.join(home, 'Library'), path.join(home, '.local/share/tagmails'), os.tmpdir(), '/tmp', '/private'];
  return folder === home || folder === '/' || folder.includes('/.codex/worktrees/') ||
    blocked.some((root) => folder === root || folder.startsWith(`${root}${path.sep}`));
}

export function readmeExcerpt(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, DESCRIPTION_CHARS);
}

async function describe(folder) {
  for (const name of ['README.md', 'README', 'readme.md', 'AGENTS.md', 'CLAUDE.md']) {
    const text = await fs.readFile(path.join(folder, name), 'utf8').catch(() => null);
    if (text?.trim()) return readmeExcerpt(text);
  }
  const pkg = await fs.readFile(path.join(folder, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
  return typeof pkg?.description === 'string' ? pkg.description.slice(0, DESCRIPTION_CHARS) : '';
}

function branch(folder) {
  try {
    const name = execFileSync('git', ['-C', folder, 'rev-parse', '--abbrev-ref', 'HEAD'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    return name && name !== 'HEAD' ? name : null;
  } catch { return null; }
}

export async function inventory({ sources = [codexProjects, claudeProjects], home = os.homedir() } = {}) {
  const found = (await Promise.all(sources.map((source) => source().catch(() => [])))).flat();
  const merged = new Map();
  for (const item of found) {
    if (typeof item.path !== 'string' || !path.isAbsolute(item.path)) continue;
    const folder = await fs.realpath(item.path).catch(() => null);
    if (!folder || excluded(folder, home) || !(await fs.stat(folder)).isDirectory()) continue;
    // Codex projects were added on purpose; a Claude session folder must look like a project.
    if (item.source !== 'codex' && !merged.has(folder) && !await looksLikeProject(folder)) continue;
    const entry = merged.get(folder) ?? { path: folder, names: new Set(), sources: new Set(), recencyAt: 0 };
    for (const name of [item.name, item.projectName, path.basename(folder)]) if (name) entry.names.add(name);
    entry.sources.add(item.source);
    entry.recencyAt = Math.max(entry.recencyAt, Number(item.recencyAt) || 0);
    merged.set(folder, entry);
  }
  const ranked = [...merged.values()].sort((a, b) => b.recencyAt - a.recencyAt).slice(0, MAX_PROJECTS);
  const projects = [];
  for (const entry of ranked) {
    const names = [...entry.names];
    projects.push({
      id: `p_${createHash('sha256').update(entry.path).digest('hex').slice(0, 10)}`,
      name: names[0].slice(0, 80), path: entry.path, aliases: names.slice(1).map((name) => name.slice(0, 80)),
      description: await describe(entry.path), branch: branch(entry.path),
      sources: [...entry.sources], recencyAt: Math.round(entry.recencyAt),
    });
  }
  return { projects, observedAt: Date.now() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await inventory())}\n`); }
  catch (error) {
    process.stderr.write(`TagMails project list: ${error.message}\n`);
    process.exitCode = 1;
  }
}
