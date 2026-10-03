const MODELS = new Set(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'claude-sonnet-5-5']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const SPEEDS = new Set(['standard', 'fast', 'ultrafast']);

export async function accountPreferences(env, account) {
  const saved = await env.DB.prepare('SELECT default_model, default_effort, default_speed FROM account_preferences WHERE account_id = ?')
    .bind(account.id).first();
  return {
    model: saved?.default_model ?? account.default_model,
    effort: saved?.default_effort ?? 'medium',
    speed: saved?.default_speed ?? 'standard',
  };
}

export async function saveAccountPreferences(env, account, input) {
  const { model, effort, speed } = input ?? {};
  if (!MODELS.has(model) || !EFFORTS.has(effort) || !SPEEDS.has(speed)) {
    throw new Error('Choose an available model, reasoning effort, and speed.');
  }
  if (model === 'claude-sonnet-5-5' && speed !== 'standard') {
    throw new Error('Claude Code does not offer this speed in the pilot.');
  }
  if (model === 'gpt-6-luna' && effort === 'ultra') {
    throw new Error('GPT-6 Luna does not offer Ultra reasoning on this Mac.');
  }
  await env.DB.prepare(`INSERT INTO account_preferences (account_id, default_model, default_effort, default_speed)
    VALUES (?, ?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET
    default_model = excluded.default_model, default_effort = excluded.default_effort,
    default_speed = excluded.default_speed`).bind(account.id, model, effort, speed).run();
  return { model, effort, speed };
}
