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

export async function accountModelCatalog(db, accountId, threadId = null) {
  const row = await db.prepare(`SELECT d.id AS device_id, d.model_catalog_json, d.model_catalog_at FROM devices d
    WHERE d.account_id = ? AND d.revoked_at IS NULL AND d.model_catalog_json IS NOT NULL
      AND d.model_catalog_at >= datetime('now', '-24 hours')
      AND (? IS NULL OR (SELECT device_id FROM threads WHERE id = ? AND account_id = ?) IS NULL
        OR d.id = (SELECT device_id FROM threads WHERE id = ? AND account_id = ?))
    ORDER BY d.model_catalog_at DESC LIMIT 1`).bind(accountId, threadId, threadId, accountId, threadId, accountId).first();
  if (!row) return { models: [], observedAt: null, deviceId: null };
  try {
    const models = JSON.parse(row.model_catalog_json);
    if (!Array.isArray(models)) throw new Error('Invalid saved catalog');
    return { models, observedAt: row.model_catalog_at, deviceId: row.device_id };
  } catch { return { models: [], observedAt: null, deviceId: null }; }
}
