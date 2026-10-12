// Decides whether a follow-up email sent while an earlier
// email in the same thread is still running should steer that run (adjust or
// add to the same task) or queue behind it (a separate task).
export const STEER_PROMPTS = {
  v1: {
    instructions: 'An agent is working on the running task. The sender has just emailed a follow-up in the same thread. Should the follow-up steer the running task, or queue as a separate task to run after it?',
    criteria: {
      steer: 'The follow-up changes, narrows, corrects, or adds to the running task, or asks about its progress.',
      queue: 'The follow-up is a separate task that does not depend on the running one.',
    },
  },
  v2: {
    instructions: 'An agent is partway through the running task. The sender emailed a follow-up in the same thread. Decide whether the agent should be redirected now or the follow-up should wait. Judge only by what the follow-up asks for, not its tone. Ignore quoted text.',
    criteria: {
      steer: 'Reading the follow-up would change what the agent should do right now: a correction, a new constraint, a changed preference, extra detail for the same deliverable, a cancel or stop, or a question about the running work.',
      queue: 'The follow-up asks for a different deliverable or a next step that needs the running task to finish first, and nothing in it changes how the running task should be done.',
    },
  },
  v3: {
    instructions: 'An agent is partway through the running task. The sender emailed a follow-up in the same thread. Select steer only if the agent should change course or add to its current work right now. Select queue when the follow-up is its own task or builds on the finished result. When unsure, select queue.',
    criteria: {
      steer: 'Correction, added constraint, changed preference, extra detail for the same deliverable, stop or cancel, or a question about the running work.',
      queue: 'A different deliverable, or a next step that builds on the finished result.',
    },
  },
  v4: {
    instructions: 'An agent is partway through the running task. The sender emailed a follow-up in the same thread. Decide what to do with it. Judge only by what the follow-up asks for. Ignore quoted text.',
    criteria: {
      steer: 'Changes what the agent should do right now: a correction, new constraint, changed preference, extra detail for the same deliverable, a cancel or stop, or a question about the running work.',
      queue: 'Asks for a different deliverable, or a next step that needs the running task to finish first.',
      ack: 'Only an acknowledgement or thanks, with no new request, for example ok, thanks, looks good.',
    },
  },
};

// A follow-up that arrives while an earlier email in the same thread is still
// running: steer (adjust the run), queue (separate task) or ack (just thanks).
// Answer request.questions with a choice, then pass the answers to finish().
export function prepareFollowUp(running, followUp, { prompt = 'v4' } = {}) {
  const def = STEER_PROMPTS[prompt];
  const request = {
    state: `Running task:\n${String(running).slice(0, 2000)}\n\nFollow-up email:\n${String(followUp).slice(0, 2000)}`,
    questions: { route: { type: 'choice', ...def } },
  };
  const finish = (answers) => {
    const answer = answers?.route;
    const choice = answer?.type === 'choice' ? answer.choice : null;
    if (choice === 'ack' && answer.probabilities?.ack >= 0.7) return 'ack';
    return choice === 'steer' && answer.probabilities?.steer >= 0.7 ? 'steer' : 'queue';
  };
  return { request, finish };
}

/** The follow-up's route, or 'queue' when it cannot be classified. */
export async function routeFollowUp(running, followUp, { ask, prompt } = {}) {
  if (!ask || !String(followUp ?? '').trim()) return 'queue';
  const prepared = prepareFollowUp(running, followUp, { prompt });
  try { return prepared.finish(await ask(prepared.request)); } catch { return 'queue'; }
}
