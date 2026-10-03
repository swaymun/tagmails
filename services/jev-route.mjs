import { chooseModel } from '../apps/mock-inbox/model.mjs';

const ROUTES = {
  codex: { id: 'gpt-6.1-sol', effort: 'medium' },
  claude: { id: 'claude-sonnet-5-5', effort: 'medium' },
  luna: { id: 'gpt-6-luna', effort: 'medium' },
};
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function confidentChoice(answer, threshold = 0.65) {
  return answer?.type === 'choice' && Number.isFinite(answer.probabilities?.[answer.choice]) &&
    answer.probabilities[answer.choice] >= threshold ? answer.choice : null;
}

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
  const knownPrior = priorModel && Object.values(ROUTES).some(({ id }) => priorModel.id === id) &&
    EFFORTS.has(priorModel.effort);
  // A malformed optional Model line is still an email request. Let Jev read
  // its intent, then use the saved route if the classification is uncertain.
  const fallback = direct.source === 'explicit' ? direct : knownPrior
    ? { id: priorModel.id, effort: priorModel.effort, source: 'thread' }
    : chooseModel('', defaultModel);
  const text = currentText(body);
  // A reply's subject may repeat an old model request. Only its new text can
  // change the thread's selected route.
  const subjectText = knownPrior ? '' : String(subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300).trim();
  const state = subjectText ? `Subject: ${subjectText}\nBody:\n${text}` : text;
  if (direct.source === 'explicit' || !apiKey || !state.trim()) return direct.error ? direct : fallback;

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
          effort: {
            type: 'choice',
            instructions: 'Choose the effort for this current email task. An explicit effort request such as Luna Low or Sonnet High takes priority. Otherwise choose low for clearly simple work, high for clearly complex multistep work, and medium when uncertain or ordinary. Reserve xhigh, max, and ultra for explicit requests. Ignore quoted earlier messages.',
            criteria: {
              low: 'Explicit low effort, or a clearly trivial task.',
              medium: 'Explicit medium effort, or ordinary or ambiguous complexity.',
              high: 'Explicit high effort, or clearly complex multistep work.',
              xhigh: 'Explicit extra high or xhigh effort.',
              max: 'Explicit max effort.',
              ultra: 'Explicit ultra reasoning effort.',
            },
          },
          speed: {
            type: 'choice',
            instructions: 'Does the sender explicitly request an inference speed tier for this email? A request to be brief or answer quickly is not necessarily a paid speed tier. Ignore quoted earlier messages.',
            criteria: {
              standard: 'No explicit speed tier request, or the sender explicitly asks for standard speed.',
              fast: 'The sender explicitly requests fast mode or the fast speed tier.',
              ultrafast: 'The sender explicitly requests ultra-fast or ultrafast mode.',
            },
          },
        },
      }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
    const answers = (await response.json()).answers;
    const routeChoice = confidentChoice(answers?.route, answers?.route?.choice === 'unsupported' ? 0.75 : 0.6);
    if (routeChoice === 'unsupported') return { error: 'That model is not available. Use Codex, Claude, or Luna.' };
    const route = Object.hasOwn(ROUTES, routeChoice) ? ROUTES[routeChoice] : null;
    const selected = route ? { ...route, source: 'classified' } : { ...fallback };
    if (route && knownPrior && route.id === priorModel.id) selected.effort = priorModel.effort;
    const effort = confidentChoice(answers?.effort, 0.7);
    if (EFFORTS.has(effort)) selected.effort = effort;
    const speed = confidentChoice(answers?.speed, 0.75);
    if (speed === 'fast' || speed === 'ultrafast') selected.speed = speed;
    return selected;
  } catch (error) {
    if (direct.source !== 'explicit') console.error('Jev model routing fell back to the saved route', error);
    return direct.error ? direct : fallback;
  }
}
