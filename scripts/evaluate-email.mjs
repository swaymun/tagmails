import fs from 'node:fs';
import path from 'node:path';
import PostalMime from 'postal-mime';
import { EMAIL_FORMAT_VERSION, escapeHtml, makeMime, renderResult } from '../apps/mock-inbox/mail.mjs';

const fixtures = [
  {
    id: 'completed', title: 'Task completed',
    result: { state: 'completed', summary: 'The beta decision is to start with Gmail and one Mac workspace.',
      details: ['Codex read the selected plan.', 'The domain purchase still needs an owner.'],
      checks: ['No domain was purchased.'],
      links: [{ label: 'Open run receipt', url: 'https://example.test/runs/1' }],
      note: 'Reply with the next decision.' },
    phrases: ['Gmail and one Mac workspace', 'No domain was purchased.', 'Reply with the next decision.'],
    links: [{ label: 'Open run receipt', url: 'https://example.test/runs/1' }],
  },
  {
    id: 'citations', title: 'Task completed',
    result: { state: 'completed', summary: 'I found two source documents.',
      details: ['One source states the limit; the other describes the exception.'],
      links: [{ label: 'Source document', url: 'https://example.test/source' },
        { label: 'Ignore unsafe link', url: 'javascript:alert(1)' },
        { label: 'Ignore relative link', url: '/runs/unknown' },
        { label: 'Ignore credential URL', url: 'https://user:secret@example.test/source' }] },
    phrases: ['two source documents', 'the exception'],
    links: [{ label: 'Source document', url: 'https://example.test/source' }],
    absent: ['Ignore unsafe link', 'javascript:alert(1)', 'Ignore relative link', 'Ignore credential URL'],
  },
  {
    id: 'image-link', title: 'Task completed',
    result: { state: 'completed', summary: 'The image draft is ready for review.',
      checks: ['Preview it in the private viewer before sharing.'],
      links: [{ label: 'Open image draft', url: 'https://example.test/private/image/1' }] },
    phrases: ['image draft is ready', 'private viewer'],
    links: [{ label: 'Open image draft', url: 'https://example.test/private/image/1' }],
  },
  {
    id: 'video-link', title: 'Task completed',
    result: { state: 'completed', summary: 'The video review cut is ready.',
      checks: ['Playback stays in the private viewer.'],
      links: [{ label: 'Watch review cut', url: 'https://example.test/private/video/1' }] },
    phrases: ['video review cut', 'Playback stays'],
    links: [{ label: 'Watch review cut', url: 'https://example.test/private/video/1' }],
  },
  {
    id: 'approval', title: 'Waiting for approval',
    result: { state: 'needs_approval', summary: 'Publishing is waiting for the owner.',
      checks: ['No site was published.'] },
    phrases: ['waiting for the owner', 'No site was published.'], absent: ['Task completed'],
  },
  {
    id: 'failure', title: 'Could not finish',
    result: { state: 'failed', summary: 'The local agent stopped before completing the task.',
      checks: ['No result file was created.'] },
    phrases: ['stopped before completing', 'No result file was created.'], absent: ['Task completed'],
  },
  {
    id: 'clarification', title: 'Which model should I use?',
    result: { state: 'needs_clarification', summary: 'Choose Codex, Claude, or Luna.' },
    phrases: ['Choose Codex, Claude, or Luna.'], absent: ['Task completed'],
  },
  {
    id: 'hostile-text', title: 'Task completed',
    result: { state: 'completed', summary: '<script>alert(1)</script> is untrusted email content.',
      details: ['The attachment name was <invoice>.'] },
    phrases: ['is untrusted email content.', 'The attachment name was'],
    escaped: ['<script>alert(1)</script>', '<invoice>'],
  },
];

const output = path.resolve(process.argv[2] ?? `.local/email-eval/${new Date().toISOString().replace(/[:.]/g, '-')}`);
fs.mkdirSync(output, { recursive: true });
const results = [];
for (const fixture of fixtures) {
  const rendered = renderResult(fixture.result);
  const mime = makeMime({ from: 'agent@tagmails.test', to: 'owner@gmail.com',
    subject: `Re: ${fixture.id}`, messageId: `<eval-${fixture.id}@tagmails.test>`,
    inReplyTo: `<request-${fixture.id}@gmail.com>`, text: rendered.text, html: rendered.html });
  const parsed = await PostalMime.parse(mime);
  const text = parsed.text ?? '';
  const html = parsed.html ?? '';
  const failures = [];
  if (!text || !html) failures.push('Multipart text or HTML is missing');
  if (!html.includes(`<h1>${fixture.title}</h1>`) || !text.startsWith(fixture.title)) failures.push('Outcome heading differs');
  if (!text.includes('Reply to this email to continue the same task.') || !html.includes('Reply to this email to continue the same task.')) failures.push('Reply continuity is missing');
  for (const phrase of fixture.phrases ?? []) {
    if (!text.includes(phrase) || !html.includes(escapeHtml(phrase))) failures.push(`Content missing: ${phrase}`);
  }
  for (const link of fixture.links ?? []) {
    if (!text.includes(`${link.label}: ${link.url}`) || !html.includes(`href="${escapeHtml(link.url)}"`)) failures.push(`Link missing: ${link.label}`);
  }
  for (const value of fixture.absent ?? []) {
    if (text.includes(value) || html.includes(value)) failures.push(`Unexpected content: ${value}`);
  }
  for (const value of fixture.escaped ?? []) {
    if (html.includes(value) || !html.includes(escapeHtml(value)) || !text.includes(value)) failures.push(`Unsafe or lost text: ${value}`);
  }
  if (html.includes('undefined') || /<script\b/i.test(html)) failures.push('Unsafe or missing-value HTML');
  fs.writeFileSync(path.join(output, `${fixture.id}.eml`), mime);
  fs.writeFileSync(path.join(output, `${fixture.id}.html`), html);
  fs.writeFileSync(path.join(output, `${fixture.id}.txt`), text);
  results.push({ id: fixture.id, passed: failures.length === 0, failures });
}
const report = { formatVersion: EMAIL_FORMAT_VERSION, testedAt: new Date().toISOString(),
  fixtures: results, limitations: [
    'Synthetic MIME and a parser check do not prove Gmail desktop or mobile rendering.',
    'Image and video fixtures test private link fallbacks; inline media is not implemented.',
    'Fixture URLs are placeholders; live artifact access and link validity are not verified.',
  ] };
fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
const passed = results.filter((item) => item.passed).length;
console.log(`Email format v${EMAIL_FORMAT_VERSION}: ${passed}/${results.length} fixtures passed. Artifacts: ${output}`);
for (const item of results.filter((entry) => !entry.passed)) console.log(`${item.id}: ${item.failures.join('; ')}`);
if (passed !== results.length) process.exitCode = 1;
