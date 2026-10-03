const MAX_EVENTS = 48;
const MAX_TEXT = 800;
const MAX_FINAL_TEXT = 8000;
const MAX_INTERMEDIATE_BYTES = 22_000;
const MAX_TRANSCRIPT_BYTES = 34_000;
const truncationBefore = new WeakMap();

function fitText(events, kind, value, characterLimit, byteLimit) {
  const clean = value.trim().slice(0, characterLimit);
  let low = 0;
  let high = clean.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = clean.slice(0, middle).replace(/[\uD800-\uDBFF]$/, '');
    const bytes = Buffer.byteLength(JSON.stringify([...events, { kind, text: candidate }]));
    if (bytes <= byteLimit) low = middle;
    else high = middle - 1;
  }
  return clean.slice(0, low).replace(/[\uD800-\uDBFF]$/, '');
}

export function runTranscript(request) {
  const transcript = { version: 1, events: [], truncated: false };
  addRunEvent(transcript, 'request', request?.body || '(Empty email body)');
  return transcript;
}

export function addRunEvent(transcript, kind, value) {
  if (!['request', 'assistant', 'tool'].includes(kind)) return;
  if (typeof value !== 'string' || !value.trim()) return;
  if (transcript.events.length >= MAX_EVENTS - 1) { transcript.truncated = true; return; }
  const clean = fitText(transcript.events, kind, value, MAX_TEXT, MAX_INTERMEDIATE_BYTES);
  if (clean) {
    const event = { kind, text: clean };
    truncationBefore.set(event, transcript.truncated);
    transcript.events.push(event);
  }
  if (clean.length < value.trim().length) transcript.truncated = true;
}

export function finishRunTranscript(transcript, answer) {
  if (typeof answer !== 'string' || !answer.trim()) return transcript;
  const original = answer.trim();
  const last = transcript.events.at(-1);
  if (last?.kind === 'assistant' && last.text === original) return transcript;
  // Claude can stream its final answer immediately before its result event.
  // Replace that short preview with the longer final answer instead of showing it twice.
  if (last?.kind === 'assistant' && original.startsWith(last.text)) {
    transcript.events.pop();
    transcript.truncated = truncationBefore.get(last) ?? transcript.truncated;
  }
  const clean = fitText(transcript.events, 'assistant', original, MAX_FINAL_TEXT, MAX_TRANSCRIPT_BYTES);
  if (clean && transcript.events.length < MAX_EVENTS) transcript.events.push({ kind: 'assistant', text: clean });
  if (clean.length < original.length || !clean) transcript.truncated = true;
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
