#!/usr/bin/env node
// Builds the agent source release and its Homebrew formula from the committed tree.
//
//   node scripts/package-agent.mjs [output-dir]
//
// Writes tagmails-<version>.tar.gz (what Homebrew and install.sh build from),
// install.sh, and Formula/tagmails.rb with the archive's checksum.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const version = JSON.parse(fs.readFileSync(path.join(root, 'agent/package.json'), 'utf8')).version;
const crate = fs.readFileSync(path.join(root, 'crates/tagmails-daemon/Cargo.toml'), 'utf8');
if (!crate.includes(`version = "${version}"`)) throw new Error(`agent/package.json ${version} must match the crate version`);

const releaseBase = process.env.TAGMAILS_RELEASE_BASE ||
  `https://github.com/swaymun/homebrew-tagmails/releases/download/v${version}`;
const destination = path.resolve(process.argv[2] || path.join(root, '.local/release', version));
fs.mkdirSync(path.join(destination, 'Formula'), { recursive: true });

const tracked = execFileSync('git', ['ls-files', 'agent', 'crates/tagmails-daemon'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((file) => file && !file.endsWith('.test.mjs'));
const files = ['Cargo.toml', 'Cargo.lock', 'LICENSE', 'packaging/install.sh', ...tracked];
const prefix = `tagmails-${version}/`;
const tar = execFileSync('git', ['archive', '--format=tar', `--prefix=${prefix}`, 'HEAD', ...files], {
  cwd: root, maxBuffer: 64 * 1024 * 1024,
});
const archive = path.join(destination, `tagmails-${version}.tar.gz`);
fs.writeFileSync(archive, gzipSync(tar, { level: 9 }));
const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
fs.copyFileSync(path.join(root, 'packaging/install.sh'), path.join(destination, 'install.sh'));

const formula = `class Tagmails < Formula
  desc "Email your coding agent: runs Codex or Claude Code for mail sent to your TagMails address"
  homepage "https://tagmails.com"
  url "${releaseBase}/tagmails-${version}.tar.gz"
  sha256 "${sha256}"
  license "MIT"

  depends_on "rust" => :build
  depends_on "node"

  def install
    system "cargo", "install", *std_cargo_args(path: "crates/tagmails-daemon")
    adapters = libexec/"tagmails"
    adapters.install Dir["agent/*.mjs"], "agent/package.json", "agent/package-lock.json"
    cd adapters do
      system "npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"
    end
  end

  def caveats
    <<~EOS
      Create a pairing code at https://tagmails.com/setup, then run:
        tagmails pair <code>
        tagmails start
      After upgrading, run \`tagmails start\` again to restart the background service.
    EOS
  end

  test do
    assert_match "tagmails #{version}", shell_output("#{bin}/tagmails --version")
    assert_match "Usage:", shell_output("#{bin}/tagmails --help")
  end
end
`;
fs.writeFileSync(path.join(destination, 'Formula/tagmails.rb'), formula);
process.stdout.write(`${archive}\nsha256 ${sha256}\n${path.join(destination, 'Formula/tagmails.rb')}\n`);
