#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'AGENT_INSTALL.md',
  'LICENSE',
  'Cargo.toml',
  'Cargo.lock',
  'crates/tagmails-daemon',
  'package.json',
  'package-lock.json',
  'scripts/install-macos-launchagent.mjs',
  'apps/mock-inbox/agent-attachments.mjs',
  'apps/mock-inbox/answer-result.mjs',
  'apps/mock-inbox/claim-renew.mjs',
  'apps/mock-inbox/claude-runner.mjs',
  'apps/mock-inbox/codex-profile.mjs',
  'apps/mock-inbox/codex-runner.mjs',
  'apps/mock-inbox/run-transcript.mjs',
];
const revision = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const destination = path.resolve(process.argv[2] || path.join(root, '.local/release'));
fs.mkdirSync(destination, { recursive: true });
const archive = execFileSync('git', ['archive', '--format=tar', 'HEAD', ...files], {
  cwd: root, maxBuffer: 16 * 1024 * 1024,
});
const output = path.join(destination, `tagmails-agent-${revision}.tar.gz`);
fs.writeFileSync(output, gzipSync(archive));
process.stdout.write(`${output}\n`);
