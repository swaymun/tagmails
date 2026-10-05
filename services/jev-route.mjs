import { chooseModel, UNAVAILABLE_MODEL } from '../apps/mock-inbox/model.mjs';

const CLAUDE = { id: 'claude-sonnet-5-5', effort: 'medium' };
const LUNA = { id: 'gpt-6-luna', effort: 'medium' };
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function confidentChoice(answer, threshold = 0.65) {
  return answer?.type === 'choice' && Number.isFinite(answer.probabilities?.[answer.choice]) &&
    answer.probabilities[answer.choice] >= threshold ? answer.choice : null;
}

export function currentText(body) {
  const lines = [];
  for (const line of String(body ?? '').split(/\r?\n/)) {
    if (/^\s*>/.test(line) || /^On .{1,200} wrote:\s*$/i.test(line) ||
        /^-{2,}\s*(?:Forwarded message|Original Message)/i.test(line)) break;
    lines.push(line);
  }
  return lines.join('\n').slice(0, 4000);
}

export async function routeModel(body, defaultModel, { apiKey, fetcher = fetch, priorModel, subject,
  pilotCodexModel, defaultEffort = 'medium', defaultSpeed = 'standard', availableModels } = {}) {
  const catalog = Array.isArray(availableModels) && availableModels.length ? availableModels : null;
  const codexModels = catalog?.filter((model) => !model.id.startsWith('claude-')) ?? [];
  const claudeModels = catalog?.filter((model) => model.id.startsWith('claude-')) ?? [];
  const codexModel = codexModels.length
    ? [pilotCodexModel, defaultModel, 'gpt-6-sol', 'gpt-6.1-sol'].find((id) => codexModels.some((model) => model.id === id)) ?? codexModels[0].id
    : pilotCodexModel === 'gpt-6-sol' ? 'gpt-6-sol' : 'gpt-6.1-sol';
  // "Use Claude" means the account's Claude default, or the machine's first Claude model.
  const claudeModel = claudeModels.length
    ? { id: (claudeModels.find((model) => model.id === defaultModel) ?? claudeModels[0]).id, effort: 'medium' } : CLAUDE;
  const routes = {
    codex: { id: codexModel, effort: 'medium' },
    claude: claudeModel,
    ...(catalog ? {} : { codex61: { id: 'gpt-6.1-sol', effort: 'medium' } }),
    ...(catalog ? {} : { luna: LUNA }),
  };
  if (catalog) {
    const luna = catalog.find((model) => /luna/i.test(model.id));
    if (luna) routes.luna = { id: luna.id, effort: 'medium' };
    catalog.forEach((model, index) => { routes[`model${index}`] = { id: model.id, effort: 'medium' }; });
  }
  const direct = chooseModel(body, defaultModel, { codexModel, availableModels: catalog });
  const knownPrior = priorModel && Object.values(routes).some(({ id }) => priorModel.id === id) &&
    EFFORTS.has(priorModel.effort);
  // Let Jev recover a natural request from a malformed Model line. If it
  // cannot identify a supported choice, ask rather than run a different model.
  const fallback = direct.source === 'explicit' ? direct : knownPrior
    ? { id: priorModel.id, effort: priorModel.effort, source: 'thread' }
    : { ...chooseModel('', defaultModel, { codexModel, availableModels: catalog }), effort: defaultEffort };
  if (direct.source !== 'explicit' && defaultSpeed !== 'standard') fallback.speed = defaultSpeed;
  const text = currentText(body);
  // A reply's subject may repeat an old model request. Only its new text can
  // change the thread's selected route.
  const subjectText = knownPrior ? '' : String(subject ?? '').replace(/[\r\n]+/g, ' ').slice(0, 300).trim();
  const state = subjectText ? `Subject: ${subjectText}\nBody:\n${text}` : text;
  function checked(selection, requested = false) {
    if (!catalog || selection.error || (selection.id === CLAUDE.id && !claudeModels.length)) return selection;
    const model = catalog.find((item) => item.id === selection.id);
    if (!model) return { error: UNAVAILABLE_MODEL };
    if (!model.efforts.includes(selection.effort)) {
      if (requested) return { error: `${selection.id} does not offer ${selection.effort} reasoning on this Mac. Choose an available effort or omit it.` };
      selection.effort = model.efforts.includes('medium') ? 'medium' : model.efforts[0];
    }
    if (!model.speeds.includes(selection.speed || 'standard')) {
      if (requested) return { error: `${selection.id} does not offer ${selection.speed} speed on this Mac. Choose an available speed or omit it.` };
      delete selection.speed;
    }
    return selection;
  }
  if (direct.source === 'explicit' || !apiKey || !state.trim()) return checked(direct.error ? direct : fallback, direct.source === 'explicit');

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
              codex: 'The sender asks to use Codex, Sol, or Seoul as a generic model name without specifying a model version.',
              claude: 'The sender asks to use Claude or Claude Code without naming a specific Claude model.',
              ...(catalog ? {} : { codex61: 'The sender explicitly asks to use GPT-6.1 Sol by version, rather than generic Codex or Sol.' }),
              ...(routes.luna ? { luna: 'The sender asks to use Luna without naming an exact version.' } : {}),
              ...Object.fromEntries((catalog ?? []).map((model, index) => [`model${index}`,
                `The sender specifically asks to use ${model.name} (${model.id}) for this task, including a clear spelling or speech transcription variant.`])),
              unsupported: 'The sender clearly asks to use a specific model outside the available choices.',
            },
          },
          requestedEffort: {
            type: 'choice',
            instructions: 'Did the sender explicitly request a reasoning effort for this task? Choose unrequested unless they name an effort, for example high reasoning, Luna Low, Sonnet High, or xhigh. Ignore quoted earlier messages.',
            criteria: {
              unrequested: 'No explicit reasoning effort request.',
              none: 'The sender explicitly asks for no reasoning, or none reasoning effort.',
              minimal: 'The sender explicitly requests minimal reasoning effort.',
              low: 'The sender explicitly requests low reasoning effort.',
              medium: 'The sender explicitly requests medium reasoning effort.',
              high: 'The sender explicitly requests high reasoning effort.',
              xhigh: 'The sender explicitly requests extra high or xhigh reasoning effort.',
              max: 'The sender explicitly requests max reasoning effort.',
              ultra: 'The sender explicitly requests ultra reasoning effort.',
            },
          },
          effort: {
            type: 'choice',
            instructions: 'If the sender did not specify reasoning effort, choose effort for the current email task based on complexity. Choose low for clearly simple work, high for clearly complex multistep work, and medium when uncertain or ordinary. Reserve xhigh, max, and ultra for explicit requests. Ignore quoted earlier messages.',
            criteria: {
              low: 'Clearly trivial task.',
              medium: 'Ordinary or ambiguous complexity.',
              high: 'Clearly complex multistep work.',
              xhigh: 'Explicit extra high or xhigh effort.',
              max: 'Explicit max effort.',
              ultra: 'Explicit ultra reasoning effort.',
            },
          },
          speed: {
            type: 'choice',
            instructions: 'Does the sender explicitly request an inference speed tier for this email? A request to be brief or answer quickly is not necessarily a paid speed tier. Ignore quoted earlier messages.',
            criteria: {
              none: 'No explicit speed tier request.',
              standard: 'The sender explicitly asks for standard speed.',
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
    const routeChoice = confidentChoice(answers?.route, 0.6);
    if (routeChoice === 'unsupported') return { error: UNAVAILABLE_MODEL };
    const route = Object.hasOwn(routes, routeChoice) ? routes[routeChoice] : null;
    if (!route && direct.error) return direct;
    const selected = route ? { ...route, effort: defaultEffort, source: 'classified' } : { ...fallback };
    if (defaultSpeed !== 'standard') selected.speed = defaultSpeed;
    if (route && knownPrior && route.id === priorModel.id) selected.effort = priorModel.effort;
    const effort = confidentChoice(answers?.effort, 0.7);
    if (EFFORTS.has(effort)) selected.effort = effort;
    const requestedEffort = confidentChoice(answers?.requestedEffort, 0.6);
    if (EFFORTS.has(requestedEffort)) selected.effort = requestedEffort;
    const speed = confidentChoice(answers?.speed, 0.75);
    if (speed === 'fast' || speed === 'ultrafast') selected.speed = speed;
    if (speed === 'standard') delete selected.speed;
    return checked(selected, EFFORTS.has(requestedEffort) || speed === 'fast' || speed === 'ultrafast');
  } catch (error) {
    if (direct.source !== 'explicit') console.error('Jev model routing fell back to the saved route', error);
    return direct.error ? direct : fallback;
  }
}
