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
    if (!label || model.effort !== effort || !['default', 'explicit', 'classified', 'thread'].includes(model.source)) return null;
    const source = {
      default: 'account default', explicit: 'requested in this email',
      classified: 'requested in this email', thread: 'continued from this thread',
    }[model.source];
    return `Selected model: ${label} (${effort}; ${source}).`;
  } catch { return null; }
}
