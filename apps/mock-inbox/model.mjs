export const ACCOUNT_DEFAULT_MODELS = ['gpt-6.1-sol', 'claude-sonnet-5-5'];

export function chooseModel(body, defaultModel = 'gpt-6.1-sol') {
  const requested = String(body ?? '').match(/^Model:\s*(.+)$/im)?.[1]?.trim().toLowerCase();
  if (!requested) return { id: ACCOUNT_DEFAULT_MODELS.includes(defaultModel) ? defaultModel : 'gpt-6.1-sol',
    effort: 'medium', source: 'default' };
  const choices = {
    codex: ['gpt-6.1-sol', 'medium'],
    'gpt-6.1-sol': ['gpt-6.1-sol', 'medium'],
    'gpt-6.1-sol medium': ['gpt-6.1-sol', 'medium'],
    claude: ['claude-sonnet-5-5', 'medium'],
    sonnet: ['claude-sonnet-5-5', 'medium'],
    'claude-sonnet-5-5': ['claude-sonnet-5-5', 'medium'],
    'claude-sonnet-5-5 medium': ['claude-sonnet-5-5', 'medium'],
    luna: ['gpt-6-luna', 'low'],
    'gpt-6-luna': ['gpt-6-luna', 'low'],
  };
  const choice = choices[requested];
  return choice ? { id: choice[0], effort: choice[1], source: 'explicit' } : { error: `“${requested.slice(0, 80)}” is not available. Use Codex, Claude, or Luna.` };
}
