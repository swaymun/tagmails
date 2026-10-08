import { chooseModel, UNAVAILABLE_MODEL } from '../apps/mock-inbox/model.mjs';

const CLAUDE = { id: 'claude-sonnet-5-5', effort: 'medium' };
const LUNA = { id: 'gpt-6-luna', effort: 'medium' };
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

// How dictation commonly mishears model names. Shown to Jev next to each name;
// they only count inside a model request ("find hotels in Seoul" is not one).
export const SOUNDS_LIKE = {
  sol: ['Seoul', 'soul', 'sole', 'saul', 'sold'],
  luna: ['loona', 'loon uh', 'lunar', 'looner', 'luner'],
  astra: ['Astro', 'astral', 'extra'],
  terra: ['Tera', 'Tara', 'terror'],
  codex: ['code x', 'codecs', 'co-decks'],
  claude: ['Cloud', 'clod', 'Claud', 'clawed'],
  sonnet: ['son it', 'sonic', 'sonnett', 'sunnet'],
  haiku: ['high cool', 'hi coo', 'hiku', 'haiko'],
  opus: ['opis', 'oh pus', 'octopus'],
  fable: ['fabel', 'table', 'favel'],
  gpt: ['GBT', 'GPD', 'chat GPT'],
};

function heard(...names) {
  const variants = [...new Set(names.flatMap((name) => SOUNDS_LIKE[String(name).toLowerCase()] ?? []))];
  return variants.length ? ` Dictation may write it as ${variants.map((variant) => `"${variant}"`).join(', ')}.` : '';
}

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
  // "Luna" or "Opus" without a version is ambiguous when the machine offers several. Name the family
  // in its own choice and send it to the newest version; the per-model choices then mean "this exact version".
  const familyOf = (model) => String(model.name ?? model.id).trim().split(/[\s-]+/).filter((word) => !/^[\d.]+$/.test(word)).pop()?.toLowerCase() || model.id;
  const version = (model) => (String(model.id).match(/\d+/g) ?? []).map(Number);
  const newest = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i += 1) { if ((a[i] ?? -1) !== (b[i] ?? -1)) return (a[i] ?? -1) - (b[i] ?? -1); } return 0; };
  const families = new Map();
  for (const model of catalog ?? []) {
    const key = `${model.id.startsWith('claude-') ? 'claude' : 'codex'}:${familyOf(model)}`;
    families.set(key, [...(families.get(key) ?? []), model]);
  }
  const ambiguous = [...families.entries()].filter(([, group]) => group.length > 1);
  const routes = {
    codex: { id: codexModel, effort: 'medium' },
    claude: claudeModel,
    ...(catalog ? {} : { codex61: { id: 'gpt-6.1-sol', effort: 'medium' } }),
    ...(catalog ? {} : { luna: LUNA }),
  };
  if (catalog) {
    catalog.forEach((model, index) => { routes[`model${index}`] = { id: model.id, effort: 'medium' }; });
    ambiguous.forEach(([key, group], index) => {
      routes[`family${index}`] = { id: [...group].sort((a, b) => newest(version(b), version(a)))[0].id, effort: 'medium' };
    });
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
            instructions: 'Does the sender ask the agent to use a specific model for this task? Select none unless a model preference is clearly requested in the current text. A reply that merely continues the task should select none. Many emails are dictated, so interpret spelling and speech-to-text variants of model names inside a model request, such as Seoul for Sol, son it for Sonnet, high cool for Haiku, or loon uh for Luna; the same words in ordinary text (find hotels in Seoul, that is cool) are not model requests. Ignore quoted messages and model names mentioned only for comparison or discussion. If a requested model is outside the supported choices, select unsupported even when its provider also has a supported model.',
            criteria: {
              none: 'No clear request to use one of the listed models for this task.',
              // With a catalog, Sol has its own model or family choice; naming it here too would split the vote.
              codex: catalog?.some((model) => familyOf(model) === 'sol')
                ? `The sender asks to use Codex without naming a model.${heard('codex')}`
                : `The sender asks to use Codex or Sol as a generic model name without specifying a model version.${heard('codex', 'sol')}`,
              claude: `The sender asks to use Claude or Claude Code and names no particular Claude model such as Opus, Sonnet, Haiku or Fable.${heard('claude')}`,
              ...(catalog ? {} : { codex61: 'The sender explicitly asks to use GPT-6.1 Sol by version, rather than generic Codex or Sol.' }),
              ...(catalog ? {} : { luna: 'The sender asks to use Luna without naming an exact version.' }),
              // One criterion per model: a duplicate "luna" choice would split the probability and neither would clear the threshold.
              ...Object.fromEntries((catalog ?? []).map((model, index) => {
                const shared = ambiguous.some(([, group]) => group.includes(model));
                const sounds = heard(...String(model.name ?? model.id).split(/[\s-]+/));
                return [`model${index}`, shared
                  ? `The sender names the exact version ${model.name} (${model.id}), not just the family name.`
                  : `The sender specifically asks to use ${model.name} (${model.id}) for this task, or just its name ${familyOf(model)}.${sounds}`];
              })),
              ...Object.fromEntries(ambiguous.map(([key, group], index) => [`family${index}`,
                `The sender asks for ${familyOf(group[0])} (${group.map((model) => model.name).join(', ')}) without naming a version.${heard(familyOf(group[0]))}`])),
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
    if (!routeChoice) console.log('Jev route unconfident', answers?.route?.choice, JSON.stringify(Object.entries(answers?.route?.probabilities ?? {}).filter(([, p]) => p > 0.05)));
    if (routeChoice === 'unsupported') return { error: UNAVAILABLE_MODEL };
    const route = Object.hasOwn(routes, routeChoice) ? routes[routeChoice] : null;
    if (!route && direct.error) return direct;
    const selected = route ? { ...route, effort: defaultEffort, source: 'classified' } : { ...fallback };
    if (defaultSpeed !== 'standard') selected.speed = defaultSpeed;
    if (route && knownPrior && route.id === priorModel.id) selected.effort = priorModel.effort;
    // A follow-up on the thread's model keeps the thread's effort unless it asks for one;
    // the complexity guess only sets effort for a new thread or a changed model.
    const effort = confidentChoice(answers?.effort, 0.7);
    const keepsThread = knownPrior && selected.id === priorModel.id;
    if (EFFORTS.has(effort) && !keepsThread) selected.effort = effort;
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
