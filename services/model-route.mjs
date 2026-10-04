const MODEL_LABELS = {
  'gpt-6.1-sol': 'Codex GPT-6.1 Sol',
  'gpt-6-sol': 'Codex GPT-6 Sol',
  'claude-sonnet-5-5': 'Claude Code Sonnet 5.5',
  'gpt-6-luna': 'Codex GPT-6 Luna',
};
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function modelLabel(id) {
  if (MODEL_LABELS[id]) return MODEL_LABELS[id];
  if (!/^gpt-[a-z0-9][a-z0-9._-]{0,62}$/.test(id ?? '')) return null;
  return `Codex ${id.split('-').map((part, index) => index === 0 ? 'GPT' :
    part.charAt(0).toUpperCase() + part.slice(1)).join('-').replace(/-([A-Z][a-z]+)$/, ' $1')}`;
}

export function selectedModelDetail(json) {
  if (!json) return null;
  try {
    const model = JSON.parse(json);
    const label = modelLabel(model.id);
    if (!label || !EFFORTS.has(model.effort) ||
        !['standard', 'fast', 'ultrafast'].includes(model.speed || 'standard') ||
        !['default', 'pilot', 'explicit', 'classified', 'thread'].includes(model.source)) return null;
    const source = {
      default: 'account default', pilot: 'available pilot default', explicit: 'requested in this email',
      classified: 'requested in this email', thread: 'continued from this thread',
    }[model.source];
    const speed = model.speed ? `${model.speed} tier requested` : 'standard speed';
    return `Selected model: ${label} (${model.effort}; ${speed}; ${source}).`;
  } catch { return null; }
}

export function selectedModelStatus(json) {
  if (!json) return null;
  try {
    const model = JSON.parse(json);
    const label = modelLabel(model.id)?.replace(/^Codex /, '').replace(/^Claude Code /, 'Claude ');
    if (!label || !EFFORTS.has(model.effort) ||
        !['standard', 'fast', 'ultrafast'].includes(model.speed || 'standard') ||
        !['default', 'pilot', 'explicit', 'classified', 'thread'].includes(model.source)) return null;
    const speed = model.speed && model.speed !== 'standard'
      ? ` · ${model.speed === 'fast' ? 'Fast' : 'Ultra-fast'}` : '';
    return `${label} ${model.effort.charAt(0).toUpperCase() + model.effort.slice(1)}${speed}`;
  } catch { return null; }
}
