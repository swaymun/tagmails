const MAX_EVENTS = 48;
const MAX_TEXT = 800;

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_TEXT) : '';
}

export function runTranscript(request) {
  const transcript = { version: 1, events: [], truncated: false };
  addRunEvent(transcript, 'request', request?.body || '(Empty email body)');
  return transcript;
}

export function addRunEvent(transcript, kind, value) {
  if (!['request', 'assistant', 'tool'].includes(kind)) return;
  const clean = text(value);
  if (!clean) return;
  if (transcript.events.length >= MAX_EVENTS - 1) { transcript.truncated = true; return; }
  if (typeof value === 'string' && value.trim().length > MAX_TEXT) transcript.truncated = true;
  transcript.events.push({ kind, text: clean });
}

export function finishRunTranscript(transcript, answer) {
  const clean = text(answer);
  if (clean && transcript.events.at(-1)?.text !== clean) {
    transcript.events.push({ kind: 'assistant', text: clean });
    if (typeof answer === 'string' && answer.trim().length > MAX_TEXT) transcript.truncated = true;
  }
  return transcript;
}

// Project only completed, user-visible items. Raw arguments, outputs, prompts,
// and reasoning can contain credentials or private file contents.
export function codexRunEvent(message) {
  if (message?.method !== 'item/completed') return null;
  const item = message.params?.item;
  if (item?.type === 'agentMessage') return { kind: 'assistant', text: item.text };
  if (item?.type === 'commandExecution') {
    return { kind: 'tool', text: `Local command ${item.status || 'finished'}${Number.isInteger(item.exitCode) ? ` (exit ${item.exitCode})` : ''}.` };
  }
  if (item?.type === 'fileChange') return { kind: 'tool', text: `File change ${item.status || 'finished'}.` };
  if (item?.type === 'mcpToolCall') return { kind: 'tool', text: `Tool ${item.server}/${item.tool} ${item.status || 'finished'}.` };
  return null;
}

export function claudeRunEvents(event) {
  if (event?.type !== 'assistant' || !Array.isArray(event.message?.content)) return [];
  return event.message.content.flatMap((block) => {
    if (block?.type === 'text') return [{ kind: 'assistant', text: block.text }];
    if (block?.type === 'tool_use' && ['Read', 'Glob', 'Grep'].includes(block.name)) {
      return [{ kind: 'tool', text: `${block.name} requested.` }];
    }
    return [];
  });
}
