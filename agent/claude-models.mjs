// Lists the Claude models this machine's Claude Code sign-in offers, through
// the Agent SDK's supportedModels() (no turn is started, nothing is billed).
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function cleanClaudeModels(rows) {
  const seen = new Set();
  const models = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = row?.resolvedModel ?? row?.value;
    if (typeof id !== 'string' || !/^claude-[a-z0-9.-]{1,60}$/.test(id) || seen.has(id) || row.value === 'default') continue;
    seen.add(id);
    const efforts = (row.supportedEffortLevels ?? []).filter((effort) => EFFORTS.has(effort));
    models.push({ id, name: String(row.displayName ?? id).slice(0, 80), harness: 'claude',
      efforts: efforts.length ? efforts : ['medium'], speeds: row.supportsFastMode ? ['standard', 'fast'] : ['standard'],
      ...(row.supportsAutoMode ? { autoMode: true } : {}) });
  }
  return models;
}

export async function probeClaudeModels({ load = () => import('@anthropic-ai/claude-agent-sdk'), timeoutMs = 20_000 } = {}) {
  const { query } = await load();
  const session = query({ prompt: (async function* () {})(), options: {
    cwd: process.env.TAGMAILS_WORKSPACE || process.cwd(),
    pathToClaudeCodeExecutable: process.env.TAGMAILS_CLAUDE_BIN || undefined,
  } });
  let timer;
  try {
    const rows = await Promise.race([session.supportedModels(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Claude model list timed out')), timeoutMs); })]);
    return { models: cleanClaudeModels(rows) };
  } finally {
    clearTimeout(timer);
    try { session.close?.(); } catch { /* Already closed. */ }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${JSON.stringify(await probeClaudeModels())}\n`); process.exit(0); }
  catch (error) { process.stderr.write(`TagMails Claude models: ${error.message}\n`); process.exit(1); }
}
