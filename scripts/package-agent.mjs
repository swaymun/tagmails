#!/usr/bin/env node
// Builds the agent release from the committed tree:
//
//   node scripts/package-agent.mjs [output-dir]
//
// - tagmails-<version>-<target>.tar.gz: prebuilt binary plus Node adapters for
//   macOS and Linux (arm64, x86_64), cross-compiled with cargo-zigbuild
// - tagmails-<version>.tar.gz: source, for install.sh's build-from-source fallback
// - install.sh and Formula/tagmails.rb with each archive's checksum
//
// Needs `zig` and `cargo-zigbuild` on PATH, plus the four rustup targets.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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

const TARGETS = {
  'aarch64-apple-darwin': 'aarch64-apple-darwin',
  'x86_64-apple-darwin': 'x86_64-apple-darwin',
  'aarch64-unknown-linux-gnu': 'aarch64-unknown-linux-gnu.2.28',
  'x86_64-unknown-linux-gnu': 'x86_64-unknown-linux-gnu.2.28',
};
const sums = {};
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const tracked = execFileSync('git', ['ls-files', 'agent', 'crates/tagmails-daemon'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((file) => file && !file.endsWith('.test.mjs'));
const files = ['Cargo.toml', 'Cargo.lock', 'LICENSE', 'packaging/install.sh', ...tracked];
const prefix = `tagmails-${version}/`;
const tar = execFileSync('git', ['archive', '--format=tar', `--prefix=${prefix}`, 'HEAD', ...files], {
  cwd: root, maxBuffer: 64 * 1024 * 1024,
});
const archive = path.join(destination, `tagmails-${version}.tar.gz`);
fs.writeFileSync(archive, gzipSync(tar, { level: 9 }));
sums.source = sha256(archive);

const adapters = execFileSync('git', ['ls-files', 'agent'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter((file) => file && !file.endsWith('.test.mjs'));
for (const [target, zigTarget] of Object.entries(TARGETS)) {
  execFileSync('cargo', ['zigbuild', '--release', '--locked', '-p', 'tagmails-daemon', '--target', zigTarget],
    { cwd: root, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env,
      // Keep the builder's home and checkout paths out of published binaries.
      RUSTFLAGS: `--remap-path-prefix=${os.homedir()}=~ --remap-path-prefix=${root}=tagmails` } });
  const stage = fs.mkdtempSync(path.join(destination, '.stage-'));
  const top = path.join(stage, `tagmails-${version}`);
  fs.mkdirSync(path.join(top, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(top, 'libexec/tagmails'), { recursive: true });
  fs.copyFileSync(path.join(root, `target/${target}/release/tagmails`), path.join(top, 'bin/tagmails'));
  fs.chmodSync(path.join(top, 'bin/tagmails'), 0o755);
  for (const file of adapters) fs.copyFileSync(path.join(root, file), path.join(top, 'libexec/tagmails', path.basename(file)));
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(top, 'LICENSE'));
  const output = path.join(destination, `tagmails-${version}-${target}.tar.gz`);
  execFileSync('tar', ['-czf', output, '-C', stage, `tagmails-${version}`], { env: { ...process.env, COPYFILE_DISABLE: '1' } });
  fs.rmSync(stage, { recursive: true, force: true });
  sums[target] = sha256(output);
}
const sumsText = Object.entries(sums).map(([target, sum]) =>
  `${sum}  tagmails-${version}${target === 'source' ? '' : `-${target}`}.tar.gz`).join('\n');
// install.sh carries this version's sums, so a tampered release download is refused.
fs.writeFileSync(path.join(destination, 'install.sh'),
  fs.readFileSync(path.join(root, 'packaging/install.sh'), 'utf8')
    .replace(/^VERSION=.*$/m, `VERSION="\${TAGMAILS_VERSION:-${version}}"`)
    .replace(/^PINNED_SUMS=.*$/m, `PINNED_SUMS='${sumsText}'`));
fs.chmodSync(path.join(destination, 'install.sh'), 0o755);
fs.writeFileSync(path.join(destination, 'SHA256SUMS'), `${sumsText}\n`);

const asset = (target) => `    url "${releaseBase}/tagmails-${version}-${target}.tar.gz"\n    sha256 "${sums[target]}"`;
const formula = `class Tagmails < Formula
  desc "Email your coding agent: runs Codex or Claude Code for mail sent to your TagMails address"
  homepage "https://tagmails.com"
  version "${version}"
  license "MIT"

  on_macos do
    on_arm do
${asset('aarch64-apple-darwin')}
    end
    on_intel do
${asset('x86_64-apple-darwin')}
    end
  end

  on_linux do
    on_arm do
${asset('aarch64-unknown-linux-gnu')}
    end
    on_intel do
${asset('x86_64-unknown-linux-gnu')}
    end
  end

  depends_on "node"

  def install
    bin.install "bin/tagmails"
    adapters = libexec/"tagmails"
    adapters.install Dir["libexec/tagmails/*"]
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
process.stdout.write(`${destination}\n${fs.readFileSync(path.join(destination, 'SHA256SUMS'), 'utf8')}`);
