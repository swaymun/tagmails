const MODEL_LABELS = {
  'gpt-6.1-sol': 'Codex GPT-6.1 Sol',
  'gpt-6-sol': 'Codex GPT-6 Sol',
  'claude-sonnet-5-5': 'Claude Code Sonnet 5.5',
  'gpt-6-luna': 'Codex GPT-6 Luna',
};
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

export function selectedModelDetail(json) {
  if (!json) return null;
  try {
    const model = JSON.parse(json);
    const label = MODEL_LABELS[model.id];
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
