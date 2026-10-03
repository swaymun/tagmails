import { chooseModel } from '../apps/mock-inbox/model.mjs';

const ROUTES = {
  codex: { id: 'gpt-6.1-sol', effort: 'medium' },
  claude: { id: 'claude-sonnet-5-5', effort: 'medium' },
  luna: { id: 'gpt-6-luna', effort: 'low' },
};

function currentText(body) {
  const lines = [];
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (/^\s*>/.test(line) || /^On .{1,200} wrote:\s*$/i.test(line) ||
        /^-{2,}\s*(?:Forwarded message|Original Message)/i.test(line)) break;
    lines.push(line);
  }
  return lines.join('\n').slice(0, 4000);
}

export async function routeModel(body, defaultModel, { apiKey, fetcher = fetch, priorModel } = {}) {
  const direct = chooseModel(body, defaultModel);
  if (direct.source === 'explicit' || direct.error) return direct;
  if (priorModel && Object.values(ROUTES).some(({ id, effort }) =>
    priorModel.id === id && priorModel.effort === effort)) {
    return { id: priorModel.id, effort: priorModel.effort, source: 'thread' };
  }
  const text = currentText(body);
  if (!apiKey || !text.trim()) return direct;

  try {
    const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'jev-1.13.0',
        state: text,
        questions: {
          route: {
            type: 'choice',
            instructions: 'Does the sender ask the agent to use a specific model for this task? Select none unless a model preference is clearly requested in the sender\'s own current message. Ignore quoted messages and model names mentioned only for comparison or discussion.',
            criteria: {
              none: 'No clear request to use one of the listed models for this task.',
              codex: 'The sender asks to use Codex or GPT-6.1 Sol.',
              claude: 'The sender asks to use Claude or Sonnet 5.5.',
              luna: 'The sender asks to use Luna or GPT-6 Luna.',
            },
          },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
    const answer = (await response.json()).answers?.route;
    const route = Object.hasOwn(ROUTES, answer?.choice) ? ROUTES[answer.choice] : null;
    const probability = answer?.probabilities?.[answer?.choice];
    if (answer?.type !== 'choice' || !route || !Number.isFinite(probability) || probability < 0.8) return direct;
    return { ...route, source: 'classified' };
  } catch (error) {
    console.error('Jev model routing fell back to the account default', error);
    return direct;
  }
}
