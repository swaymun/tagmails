import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareCodexProfile } from './codex-profile.mjs';
import { codexEnvironment, restrictedConfiguration } from './codex-runner.mjs';

export async function probeCodexModels(workspace) {
  const home = await prepareCodexProfile(workspace);
  const child = spawn(process.env.TAGMAILS_CODEX_BIN || 'codex', ['app-server'], {
    cwd: workspace, env: codexEnvironment(home), stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.on('error', () => {});
  child.stderr.resume();
  const lines = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let nextId = 1;
  let bytes = 0;
  const fail = (error) => { for (const target of pending.values()) target.reject(error); pending.clear(); };
  child.once('error', fail);
  child.once('close', (code) => fail(new Error(`Codex app-server exited with ${code}`)));
  lines.on('line', (line) => {
    bytes += Buffer.byteLength(line);
    if (bytes > 2_000_000) { fail(new Error('Codex catalog response is too large')); child.kill(); return; }
    let message;
    try { message = JSON.parse(line); }
    catch { fail(new Error('Invalid Codex app-server response')); child.kill(); return; }
    if (message.id !== undefined && !message.method) {
      const target = pending.get(message.id);
      if (!target) return;
      pending.delete(message.id);
      if (message.error) target.reject(new Error(message.error.message || 'Codex request failed'));
      else target.resolve(message.result);
    } else if (message.id !== undefined) {
      child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601,
        message: 'TagMails catalog probe does not grant runtime requests' } })}\n`);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
  const timer = setTimeout(() => { fail(new Error('Codex catalog probe timed out')); child.kill(); }, 10_000);
  try {
    await request('initialize', { clientInfo: { name: 'tagmails', title: 'TagMails', version: '0.1.0' },
      capabilities: { experimentalApi: true } });
    child.stdin.write(`${JSON.stringify({ method: 'initialized', params: {} })}\n`);
    restrictedConfiguration(await request('config/read', { cwd: workspace, includeLayers: true }));
    const catalog = await request('model/list', { includeHidden: false, limit: 100 });
    if (!Array.isArray(catalog?.data)) throw new Error('Codex app-server returned no model list');
    return { models: catalog.data.map((model) => ({ id: model.id,
      name: model.displayName ?? model.name ?? model.id,
      supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
      serviceTiers: model.serviceTiers ?? [] })) };
  } finally { clearTimeout(timer); child.kill(); lines.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const selected = process.env.TAGMAILS_WORKSPACE;
    if (!selected || !path.isAbsolute(selected) || !(await fs.stat(selected)).isDirectory()) {
      throw new Error('Select an absolute TAGMAILS_WORKSPACE directory');
    }
    process.stdout.write(`${JSON.stringify(await probeCodexModels(await fs.realpath(selected)))}\n`);
  } catch (error) {
    process.stderr.write(`TagMails catalog probe: ${error.message}\n`);
    process.exitCode = 1;
  }
}
