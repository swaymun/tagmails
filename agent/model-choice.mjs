export const ACCOUNT_DEFAULT_MODELS = ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'claude-sonnet-5-5'];
export const UNAVAILABLE_MODEL = 'That model is unavailable for this agent. Ask for an available OpenAI or Claude model, or omit the model to use your default.';
const UNKNOWN_MODEL = 'I could not identify an available OpenAI or Claude model in this request. Reply with a supported model, or omit the model to use your default.';

function requestedModel(body) {
  let inDirectives = false;
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (!line.trim()) {
      if (inDirectives) break;
      continue;
    }
    const model = line.match(/^Model:[ \t]*(.*)$/i);
    if (model) return model[1].trim().toLowerCase();
    if (/^TagMails-(?:Attach|File):/i.test(line)) {
      inDirectives = true;
      continue;
    }
    break;
  }
  return null;
}

export function chooseModel(body, defaultModel = 'gpt-6.1-sol', { codexModel = 'gpt-6.1-sol', availableModels } = {}) {
  const requested = requestedModel(body);
  if (requested === null) {
    const ids = Array.isArray(availableModels) && availableModels.length
      ? availableModels.map((model) => model.id) : ACCOUNT_DEFAULT_MODELS;
    const saved = ids.includes(defaultModel) ? defaultModel : ids.includes(codexModel) ? codexModel : ids[0];
    return { id: saved === 'gpt-6.1-sol' ? codexModel : saved,
      effort: 'medium', source: saved === 'gpt-6.1-sol' && codexModel !== saved ? 'pilot' : 'default' };
  }
  if (!requested) return { error: UNKNOWN_MODEL };
  const choices = {
    codex: [codexModel, 'medium'],
    sol: [codexModel, 'medium'],
    'gpt-6 sol': ['gpt-6-sol', 'medium'],
    'gpt-6-sol': ['gpt-6-sol', 'medium'],
    'codex 6.1 sol': ['gpt-6.1-sol', 'medium'],
    'codex 6.1 sol medium': ['gpt-6.1-sol', 'medium'],
    'gpt-6.1 sol': ['gpt-6.1-sol', 'medium'],
    'gpt-6.1 sol medium': ['gpt-6.1-sol', 'medium'],
    'gpt-6.1-sol': ['gpt-6.1-sol', 'medium'],
    'gpt-6.1-sol medium': ['gpt-6.1-sol', 'medium'],
    claude: ['claude-sonnet-5-5', 'medium'],
    sonnet: ['claude-sonnet-5-5', 'medium'],
    'sonnet 5.5': ['claude-sonnet-5-5', 'medium'],
    'sonnet 5.5 medium': ['claude-sonnet-5-5', 'medium'],
    'claude sonnet 5.5': ['claude-sonnet-5-5', 'medium'],
    'claude sonnet 5.5 medium': ['claude-sonnet-5-5', 'medium'],
    'claude-sonnet-5-5': ['claude-sonnet-5-5', 'medium'],
    'claude-sonnet-5-5 medium': ['claude-sonnet-5-5', 'medium'],
    luna: ['gpt-6-luna', 'medium'],
    'gpt-6-luna': ['gpt-6-luna', 'medium'],
  };
  // With a live catalog, "claude" means the machine's first Claude model.
  const firstClaude = availableModels?.find((model) => model.id.startsWith('claude-'))?.id;
  if (firstClaude) { choices.claude = [firstClaude, 'medium']; choices['claude code'] = [firstClaude, 'medium']; }
  for (const model of availableModels ?? []) choices[model.id] = [model.id, 'medium'];
  const match = requested.match(/^(.*?)(?:\s+(low|medium|high|xhigh|max|ultra))?$/);
  const choice = choices[match?.[1]];
  return choice && (!availableModels?.length || availableModels.some((model) => model.id === choice[0]))
    ? { id: choice[0], effort: match[2] || choice[1], source: 'explicit' } : {
    error: UNKNOWN_MODEL,
  };
}
