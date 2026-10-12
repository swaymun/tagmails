// Contract: every relative link and image in the tracked Markdown docs points at a file
// in the repo, and every #anchor at a heading in its target. Guards against removing a
// doc (or renaming a heading) while README or another doc still links to it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// A link must point at a tracked file (or a folder holding one): an ignored local file would pass on
// the author's machine and 404 on GitHub.
const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const inRepo = (relative) => files.some((file) => file === relative || file.startsWith(`${relative}/`));
const tracked = files.filter((file) => file.endsWith('.md') && !file.startsWith('site/') && fs.existsSync(path.join(root, file)));

// GitHub's heading anchors: lowercase, punctuation dropped, spaces to hyphens.
const slug = (heading) => heading.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
const anchors = (file) => new Set(fs.readFileSync(file, 'utf8').split('\n')
  .filter((line) => /^#{1,6} /.test(line)).map((line) => slug(line.replace(/^#+ /, ''))));

test('relative links in Markdown docs resolve', () => {
  const broken = [];
  for (const file of tracked) {
    const text = fs.readFileSync(path.join(root, file), 'utf8').replace(/```[\s\S]*?```/g, '');
    const targets = [...text.matchAll(/\]\(([^)\s]+)\)/g), ...text.matchAll(/(?:href|src|srcset)="([^"]+)"/g)].map((match) => match[1]);
    for (const target of targets) {
      if (/^(https?:|mailto:)/.test(target)) continue;
      const [link, anchor] = target.split('#');
      const resolved = link ? path.resolve(path.dirname(path.join(root, file)), link) : path.join(root, file);
      if (!inRepo(path.relative(root, resolved))) broken.push(`${file}: ${target}`);
      else if (anchor && resolved.endsWith('.md') && !anchors(resolved).has(anchor)) broken.push(`${file}: ${target} (no such heading)`);
    }
  }
  assert.deepEqual(broken, []);
});
