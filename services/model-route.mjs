const MODEL_LABELS = {
  'gpt-6.1-sol': ['Codex GPT-6.1 Sol', 'medium'],
  'claude-sonnet-5-5': ['Claude Code Sonnet 5.5', 'medium'],
  'gpt-6-luna': ['Codex GPT-6 Luna', 'low'],
};

export function selectedModelDetail(json) {
  if (!json) return null;
  try {
    const model = JSON.parse(json);
    const [label, effort] = MODEL_LABELS[model.id] ?? [];
    if (!label || model.effort !== effort || !['default', 'explicit'].includes(model.source)) return null;
    const source = model.source === 'explicit' ? 'requested in this email' : 'account default';
    return `Selected model: ${label} (${effort}; ${source}).`;
  } catch { return null; }
}
