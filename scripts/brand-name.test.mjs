import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// The brand is "Tagmails". Only machine markers keep the old capital M:
// TagMails-Attach:, TagMails-File:, X-TagMails-* headers (always followed by "-").
const OLD = new RegExp(`${'Tag'}${'Mails'}(?!-)`);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BINARY = /\.(pdf|png|jpe?g|gif|webp|ico|woff2?|ttf|zip|gz|eml)$/i;

function trackedFiles(directory) {
  try {
    return execFileSync('git', ['-C', directory, 'ls-files'], { encoding: 'utf8' })
      .split('\n').filter(Boolean).map((file) => path.join(directory, file));
  } catch { return []; }
}

test('user-facing text spells the brand "Tagmails"', () => {
  const site = path.join(root, 'site');
  const files = [...trackedFiles(root), ...(fs.existsSync(path.join(site, 'dist')) ? trackedFiles(site) : [])]
    .filter((file) => !BINARY.test(file) && fs.existsSync(file) && fs.statSync(file).isFile());
  const offenders = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => { if (OLD.test(line)) offenders.push(`${path.relative(root, file)}:${index + 1}`); });
  }
  assert.deepEqual(offenders, [], 'write "Tagmails" (machine markers like TagMails-Attach: are exempt)');
});
