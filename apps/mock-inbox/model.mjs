export const ACCOUNT_DEFAULT_MODELS = ['gpt-6.1-sol', 'claude-sonnet-5-5'];

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
  if (!requested) return { error: 'Choose Codex, Claude, or Luna after Model:.' };
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
    luna: ['gpt-6-luna', 'low'],
    'gpt-6-luna': ['gpt-6-luna', 'low'],
  };
  const choice = choices[requested];
  return choice ? { id: choice[0], effort: choice[1], source: 'explicit' } : { error: `“${requested.slice(0, 80)}” is not available. Use Codex, Claude, or Luna.` };
}
