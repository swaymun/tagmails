const MODEL_ID = /^[a-z][a-z0-9][a-z0-9._-]{0,62}$/;
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function validModelId(id) {
  return typeof id === 'string' && MODEL_ID.test(id) && !id.startsWith('claude-');
}

export function cleanCodexCatalog(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 40) throw new Error('Invalid model catalog');
  const seen = new Set();
  return input.map((model) => {
    if (!validModelId(model?.id) || seen.has(model.id) ||
        !Array.isArray(model.supportedReasoningEfforts) || model.supportedReasoningEfforts.length > 12 ||
        !Array.isArray(model.serviceTiers) || model.serviceTiers.length > 8) {
      throw new Error('Invalid model catalog');
    }
    seen.add(model.id);
    const efforts = [...new Set(model.supportedReasoningEfforts.map((item) => item?.reasoningEffort))];
    if (!efforts.length || efforts.some((effort) => !EFFORTS.has(effort))) throw new Error('Invalid model catalog');
    const speeds = ['standard'];
    for (const tier of model.serviceTiers) {
      const name = String(tier?.name ?? '').toLowerCase().replace(/[\s-]+/g, '');
      if (tier?.id === 'fast' || tier?.id === 'priority' || name === 'fast') speeds.push('fast');
      if (tier?.id === 'ultrafast' || name === 'ultrafast') speeds.push('ultrafast');
    }
    const name = typeof model.name === 'string' && model.name.length <= 80 && model.name.trim()
      ? model.name.trim() : model.id;
    return { id: model.id, name, efforts, speeds: [...new Set(speeds)] };
  });
}

const CLAUDE_ID = /^claude-[a-z0-9.-]{1,60}$/;
const CLAUDE_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

// Claude models arrive already shaped by agent/claude-models.mjs.
export function cleanClaudeCatalog(input) {
  if (!Array.isArray(input) || input.length > 20) throw new Error('Invalid Claude catalog');
  const seen = new Set();
  return input.map((model) => {
    if (!CLAUDE_ID.test(model?.id ?? '') || seen.has(model.id) || !Array.isArray(model.efforts) ||
        !model.efforts.length || model.efforts.some((effort) => !CLAUDE_EFFORTS.has(effort)) ||
        !Array.isArray(model.speeds) || model.speeds.some((speed) => !['standard', 'fast'].includes(speed))) {
      throw new Error('Invalid Claude catalog');
    }
    seen.add(model.id);
    const name = typeof model.name === 'string' && model.name.trim() && model.name.length <= 80 ? model.name.trim() : model.id;
    // Claude Code has no speed tiers; only Codex models offer fast modes.
    return { id: model.id, name, harness: 'claude', efforts: [...new Set(model.efforts)], speeds: ['standard'] };
  });
}

export function catalogFromDevice(body) {
  const codex = Array.isArray(body?.models) && body.models.length
    ? cleanCodexCatalog(body.models).map((model) => ({ ...model, harness: 'codex' })) : [];
  const claude = body?.claudeModels ? cleanClaudeCatalog(body.claudeModels) : [];
  if (!codex.length && !claude.length) throw new Error('Invalid model catalog');
  return [...codex, ...claude];
}

// The computer's own defaults, kept only where its catalog supports them.
export function deviceDefaults(input, models) {
  if (!input || typeof input !== 'object') return null;
  const model = models.find((item) => item.id === input.model);
  if (!model) return null;
  const out = { model: model.id };
  if (model.efforts.includes(input.effort)) out.effort = input.effort;
  if (model.speeds.includes(input.speed)) out.speed = input.speed;
  return out;
}

// The most a computer allows, from `tagmails start --access/--claude-permission`.
export function deviceLimits(input) {
  const codex = (value) => ['read', 'write', 'full'].includes(value) ? value : null;
  const claude = (value) => ['readonly', 'manual', 'acceptEdits', 'auto', 'bypassPermissions'].includes(value) ? value : null;
  const access = codex(input?.access);
  const claudePermission = claude(input?.claudePermission);
  if (!access && !claudePermission) return null;
  // The machine's maximum, plus its own default used when the site hasn't chosen.
  return { access, claudePermission,
    ...(codex(input?.defaultAccess) ? { defaultAccess: input.defaultAccess } : {}),
    ...(claude(input?.defaultClaudePermission) ? { defaultClaudePermission: input.defaultClaudePermission } : {}) };
}

export async function accountModelCatalog(db, accountId, threadId = null) {
  const row = await db.prepare(`SELECT d.id AS device_id, d.model_catalog_json, d.model_catalog_at, d.defaults_json, d.limits_json FROM devices d
    WHERE d.account_id = ? AND d.revoked_at IS NULL AND d.model_catalog_json IS NOT NULL
      AND d.model_catalog_at >= datetime('now', '-24 hours')
      AND (? IS NULL OR (SELECT device_id FROM threads WHERE id = ? AND account_id = ?) IS NULL
        OR d.id = (SELECT device_id FROM threads WHERE id = ? AND account_id = ?))
    ORDER BY d.model_catalog_at DESC LIMIT 1`).bind(accountId, threadId, threadId, accountId, threadId, accountId).first();
  if (!row) return { models: [], observedAt: null, deviceId: null, defaults: null };
  try {
    const models = JSON.parse(row.model_catalog_json);
    if (!Array.isArray(models)) throw new Error('Invalid saved catalog');
    let defaults = null;
    try { defaults = deviceDefaults(JSON.parse(row.defaults_json ?? 'null'), models); } catch { /* Ignore. */ }
    let limits = null;
    try { limits = deviceLimits(JSON.parse(row.limits_json ?? 'null')); } catch { /* Ignore. */ }
    return { models, observedAt: row.model_catalog_at, deviceId: row.device_id, defaults, limits };
  } catch { return { models: [], observedAt: null, deviceId: null, defaults: null }; }
}
