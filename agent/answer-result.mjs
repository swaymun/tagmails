const SUMMARY_LIMIT = 500;
const DETAIL_LIMIT = 300;
const DETAIL_COUNT = 12;
export const ANSWER_LIMIT = 32_000;

function take(text, limit, preferParagraph = false) {
  const paragraph = text.indexOf('\n\n');
  if (preferParagraph && paragraph > 0 && paragraph <= limit) {
    return [text.slice(0, paragraph).trim(), text.slice(paragraph).trimStart()];
  }
  if (text.length <= limit) return [text.trim(), ''];
  let end = limit;
  const whitespace = text.slice(0, limit + 1).search(/\s+[^\s]*$/);
  if (whitespace >= limit - 60 && whitespace > 0) end = whitespace;
  return [text.slice(0, end).trim(), text.slice(end).trimStart()];
}

export function formatAgentAnswer(answer) {
  let remaining = answer.trim().replace(/\r\n/g, '\n');
  if (!remaining) return null;
  let summary;
  [summary, remaining] = take(remaining, SUMMARY_LIMIT, true);
  const details = [];
  while (remaining && details.length < DETAIL_COUNT) {
    let detail;
    [detail, remaining] = take(remaining, DETAIL_LIMIT, true);
    if (detail) details.push(detail);
  }
  const full = answer.trim().replace(/\r\n/g, '\n');
  return { summary, details, truncated: Boolean(remaining),
    answer: full.slice(0, ANSWER_LIMIT), answerTruncated: full.length > ANSWER_LIMIT };
}
