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
const RECENT_REQUESTS = 3;
const REQUEST_CHARS = 160;
const TOP_LEVEL_ENTRIES = 30;

async function codexProjects({ withHistory = true, home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex') } = {}) {
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
    await request('initialize', { clientInfo: { name: 'tagmails', title: 'TagMails', version: '0.2.2' },
      capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    const list = await request('project/list', { limit: 100 });
    const roots = (list?.data ?? []).flatMap((project) => (project.roots ?? []).map((root) => ({
      path: root.path, name: project.roots.length > 1 ? path.basename(root.path) : project.name,
      projectName: project.name, recencyAt: (project.recencyAt ?? project.updatedAt ?? 0) * 1000, source: 'codex',
      requests: [],
    })));
    if (withHistory && roots.length) {
      await Promise.all(roots.map(async (root) => {
        const threads = await request('thread/list', { cwd: root.path, limit: 10, useStateDbOnly: true, sortKey: 'updated_at' }).catch(() => null);
        for (const thread of threads?.data ?? []) {
          if (thread.parentThreadId || typeof thread.preview !== 'string') continue;
          root.requests.push({ at: (thread.updatedAt ?? thread.createdAt ?? 0) * 1000, text: thread.preview });
        }
      }));
    }
    return roots;
  } finally { clearTimeout(timer); child.kill(); lines.close(); }
}

// The first message a person typed in a session, without injected context.
export function humanRequest(text) {
  let t = String(text ?? '')
    .replace(/<(recommended_plugins|environment_context|in-app-browser-context|codex_internal_context|system-reminder|local-command-[a-z]+|command-[a-z]+)[^>]*>[\s\S]*?<\/\1>/g, ' ')
    .replace(/<image[^>]*>\s*<\/image>/g, ' ');
  const request = t.match(/##\s*My request:\s*([\s\S]*)/);
  if (request?.[1].trim()) t = request[1];
  t = t.replace(/\s+/g, ' ').trim();
  if (!t || /^(# AGENTS\.md|<|Caveat:|# Files (mentioned|pasted) by the user)/.test(t) ||
      /^(you are handling an email|the following (email|is the codex agent history)|return exactly|reply (with )?exactly)/i.test(t) ||
      /reply (with )?exactly|exact reply code|disposable native computer-use test|session setup [0-9a-f]{8}-/i.test(t)) return null;
  return t;
}

function redact(text, home = os.homedir()) {
  return text.split(home).join('~')
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '<email>')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|re_[A-Za-z0-9]{6,}_[A-Za-z0-9_]+|tm_(?:dev|pair)_[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]+)/g, '<secret>')
    .replace(/((?:api[_ -]?key|token|password|secret)\s*[:=]\s*)\S+/gi, '$1<secret>')
    .slice(0, REQUEST_CHARS);
}

async function firstCwd(file) {
  const handle = await fs.open(file);
  let cwd = null;
  try {
    const lines = readline.createInterface({ input: handle.createReadStream({ end: 256 * 1024 }) });
    let count = 0;
    for await (const line of lines) {
      if (++count > 300) break;
      try {
        const entry = JSON.parse(line);
        if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;
        if (entry.type === 'user' && !entry.isSidechain) {
          const content = entry.message?.content;
          const text = humanRequest(Array.isArray(content)
            ? content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n') : content);
          if (text) return { cwd: entry.cwd ?? cwd, request: text };
        }
      } catch { /* Skip partial lines. */ }
    }
  } finally { await handle.close(); }
  return cwd ? { cwd, request: null } : null;
}

async function claudeProjects({ withHistory = true, root = path.join(os.homedir(), '.claude/projects') } = {}) {
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
  for (const session of sessions.slice(0, 400)) {
    const folder = seen.get(session.folder);
    if (folder && (!withHistory || folder.requests.length >= RECENT_REQUESTS)) continue;
    if (!folder && seen.size >= MAX_PROJECTS) continue;
    const first = await firstCwd(session.file).catch(() => null);
    if (!first?.cwd) continue;
    const entry = folder ?? { path: first.cwd, name: path.basename(first.cwd), recencyAt: session.mtime, source: 'claude', requests: [] };
    if (withHistory && first.request) entry.requests.push({ at: session.mtime, text: first.request });
    seen.set(session.folder, entry);
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

function repository(folder) {
  try {
    const url = execFileSync('git', ['-C', folder, 'remote', 'get-url', 'origin'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim();
    // Only the repository name; remote URLs can embed credentials.
    return url.split(/[/:]/).pop().replace(/\.git$/, '').slice(0, 100) || null;
  } catch { return null; }
}

async function topLevel(folder) {
  const entries = await fs.readdir(folder).catch(() => []);
  return entries.filter((name) => !name.startsWith('.')).sort().slice(0, TOP_LEVEL_ENTRIES).map((name) => name.slice(0, 80));
}

// What the relay sees about each folder. "full" (default) adds the first line of
// the last few sessions there; "files" sends only names, README, repository and
// top-level entries. The October 5 study: full routed 73/132 real requests
// correctly, files-only 41, README alone 39, none wrong.
export async function inventory({ sources, home = os.homedir(), context = process.env.TAGMAILS_ROUTING_CONTEXT || 'full' } = {}) {
  const withHistory = context !== 'files';
  sources ??= [() => codexProjects({ withHistory }), () => claudeProjects({ withHistory })];
  const found = (await Promise.all(sources.map((source) => source().catch(() => [])))).flat();
  const merged = new Map();
  for (const item of found) {
    if (typeof item.path !== 'string' || !path.isAbsolute(item.path)) continue;
    const folder = await fs.realpath(item.path).catch(() => null);
    if (!folder || excluded(folder, home) || !(await fs.stat(folder)).isDirectory()) continue;
    // Codex projects were added on purpose; a Claude session folder must look like a project.
    if (item.source !== 'codex' && !merged.has(folder) && !await looksLikeProject(folder)) continue;
    const entry = merged.get(folder) ?? { path: folder, names: new Set(), sources: new Set(), recencyAt: 0, requests: [] };
    entry.requests.push(...(item.requests ?? []));
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
      repository: repository(entry.path), topLevel: await topLevel(entry.path),
      ...(withHistory ? { recentRequests: [...entry.requests].sort((a, b) => b.at - a.at)
        .map((item) => humanRequest(item.text)).filter(Boolean).slice(0, RECENT_REQUESTS).map((text) => redact(text, home)) } : {}),
      lastActiveDaysAgo: entry.recencyAt ? Math.max(0, Math.round((Date.now() - entry.recencyAt) / 864e5)) : null,
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
