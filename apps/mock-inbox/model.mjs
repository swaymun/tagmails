export const ACCOUNT_DEFAULT_MODELS = ['gpt-6.1-sol', 'claude-sonnet-5-5'];
const UNKNOWN_MODEL = 'I could not identify an available model in this request. Ask for Codex, Claude, or Luna, or omit the model to use your default.';

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

export function chooseModel(body, defaultModel = 'gpt-6.1-sol') {
  const requested = requestedModel(body);
  if (requested === null) return { id: ACCOUNT_DEFAULT_MODELS.includes(defaultModel) ? defaultModel : 'gpt-6.1-sol',
    effort: 'medium', source: 'default' };
  if (!requested) return { error: UNKNOWN_MODEL };
  const choices = {
    codex: ['gpt-6.1-sol', 'medium'],
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
  const match = requested.match(/^(.*?)(?:\s+(low|medium|high|xhigh|max|ultra))?$/);
  const choice = choices[match?.[1]];
  return choice ? { id: choice[0], effort: match[2] || choice[1], source: 'explicit' } : {
    error: UNKNOWN_MODEL,
  };
}
