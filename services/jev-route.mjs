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

export async function routeModel(body, defaultModel, { apiKey, fetcher = fetch, priorModel, subject } = {}) {
  const direct = chooseModel(body, defaultModel);
  if (direct.source === 'explicit' || direct.error) return direct;
  const knownPrior = priorModel && Object.values(ROUTES).some(({ id, effort }) =>
    priorModel.id === id && priorModel.effort === effort);
  const fallback = knownPrior
    ? { id: priorModel.id, effort: priorModel.effort, source: 'thread' } : direct;
  const text = currentText(body);
  // A reply's subject may repeat an old model request. Only its new text can
  // change the thread's selected route.
  const subjectText = knownPrior ? '' : String(subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300).trim();
  const state = subjectText ? `Subject: ${subjectText}\nBody:\n${text}` : text;
  if (!apiKey || !state.trim()) return fallback;

  try {
    const response = await fetcher('https://api.typesafe.ai/v1/systemone', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'jev-1.13.0',
        state,
        questions: {
          route: {
            type: 'choice',
            instructions: 'Does the sender ask the agent to use a specific model for this task? Select none unless a model preference is clearly requested in the current text. A reply that merely continues the task should select none. Interpret obvious spelling or speech transcription variants of model names in a model request, such as Seoul for Sol. Ignore quoted messages and model names mentioned only for comparison or discussion. If a requested model is outside the supported choices, select unsupported even when its provider also has a supported model.',
            criteria: {
              none: 'No clear request to use one of the listed models for this task.',
              codex: 'The sender asks to use Codex or GPT-6.1 Sol.',
              claude: 'The sender asks to use Claude without naming another variant, or specifically asks for Sonnet 5.5.',
              luna: 'The sender asks to use Luna or GPT-6 Luna.',
              unsupported: 'The sender clearly asks to use an unavailable model or a named variant other than the supported Codex, Sonnet 5.5, and Luna choices.',
            },
          },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
    const answer = (await response.json()).answers?.route;
    const probability = answer?.probabilities?.[answer?.choice];
    const threshold = answer?.choice === 'unsupported' ? 0.75 : 0.6;
    if (answer?.type !== 'choice' || !Number.isFinite(probability) || probability < threshold) return fallback;
    if (answer.choice === 'unsupported') return { error: 'That model is not available. Use Codex, Claude, or Luna.' };
    const route = Object.hasOwn(ROUTES, answer.choice) ? ROUTES[answer.choice] : null;
    if (!route) return fallback;
    return { ...route, source: 'classified' };
  } catch (error) {
    console.error('Jev model routing fell back to the saved route', error);
    return fallback;
  }
}
