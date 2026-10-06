import { accountModelCatalog } from './model-catalog.mjs';

const LEGACY_MODELS = new Set(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'claude-sonnet-5-5']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const SPEEDS = new Set(['standard', 'fast', 'ultrafast']);
export const CODEX_ACCESS = ['read', 'write', 'full'];
export const CLAUDE_PERMISSIONS = ['manual', 'acceptEdits', 'auto', 'bypassPermissions'];
// Mirrors the daemon's default ceiling when the computer hasn't reported one.
const DEFAULT_MAX_ACCESS = 'write';
const DEFAULT_MAX_CLAUDE_PERMISSION = 'auto';

// A default saved on the website wins, then the computer's own default
// (`tagmails start --model ...`), then the account's original model.
export async function accountPreferences(env, account) {
  const saved = await env.DB.prepare(`SELECT default_model, default_effort, default_speed, codex_access, claude_permission
    FROM account_preferences WHERE account_id = ?`).bind(account.id).first();
  const catalog = await accountModelCatalog(env.DB, account.id);
  const permissions = { codexAccess: saved?.codex_access ?? null, claudePermission: saved?.claude_permission ?? null,
    limits: catalog.limits ?? null };
  if (saved?.default_model) {
    return { model: saved.default_model, effort: saved.default_effort, speed: saved.default_speed, source: 'site', ...permissions };
  }
  const computer = catalog.defaults;
  const original = account.default_model ?? (await env.DB.prepare('SELECT default_model FROM accounts WHERE id = ?')
    .bind(account.id).first())?.default_model;
  return {
    model: computer?.model ?? original,
    effort: computer?.effort ?? 'medium',
    speed: computer?.speed ?? 'standard',
    source: computer ? 'computer' : 'default',
    ...permissions,
  };
}

export async function clearAccountPreferences(env, account) {
  // Hand the model back to the computer; keep any permission choice.
  await env.DB.prepare(`UPDATE account_preferences SET default_model = NULL, default_effort = NULL, default_speed = NULL
    WHERE account_id = ?`).bind(account.id).run();
  return accountPreferences(env, account);
}

export async function saveAccountPreferences(env, account, input) {
  const { model, effort, speed, codexAccess = null, claudePermission = null } = input ?? {};
  if ((codexAccess !== null && !CODEX_ACCESS.includes(codexAccess)) ||
      (claudePermission !== null && !CLAUDE_PERMISSIONS.includes(claudePermission))) {
    throw new Error('Choose an available permission.');
  }
  const catalog = await accountModelCatalog(env.DB, account.id);
  // The website can't choose above what the computer allows; full access and
  // bypass need an explicit opt-in on the computer itself.
  const above = (order, value, max) => value !== null && order.indexOf(value) > order.indexOf(max);
  if (above(CODEX_ACCESS, codexAccess, catalog.limits?.access ?? DEFAULT_MAX_ACCESS) ||
      above(CLAUDE_PERMISSIONS, claudePermission, catalog.limits?.claudePermission ?? DEFAULT_MAX_CLAUDE_PERMISSION)) {
    throw new Error('Your computer does not allow that permission. Raise it there with tagmails start --max-access or --max-claude-permission.');
  }
  const available = catalog.models.find((item) => item.id === model);
  if (!(catalog.models.length ? available || (model === 'claude-sonnet-5-5' && env.CLAUDE_ROUTE_ENABLED === 'true')
    : LEGACY_MODELS.has(model)) || !EFFORTS.has(effort) || !SPEEDS.has(speed)) {
    throw new Error('Choose an available model, reasoning effort, and speed.');
  }
  if (available && (!available.efforts.includes(effort) || !available.speeds.includes(speed))) {
    throw new Error('That model does not offer the selected reasoning effort or speed on this Mac.');
  }
  if (!available && model === 'claude-sonnet-5-5' && speed !== 'standard') {
    throw new Error('Claude Code does not offer this speed in the pilot.');
  }
  if (model === 'gpt-6-luna' && effort === 'ultra') {
    throw new Error('GPT-6 Luna does not offer Ultra reasoning on this Mac.');
  }
  await env.DB.prepare(`INSERT INTO account_preferences (account_id, default_model, default_effort, default_speed,
    codex_access, claude_permission) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET
    default_model = excluded.default_model, default_effort = excluded.default_effort,
    default_speed = excluded.default_speed, codex_access = excluded.codex_access,
    claude_permission = excluded.claude_permission`)
    .bind(account.id, model, effort, speed, codexAccess, claudePermission).run();
  return accountPreferences(env, account);
}
