#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.tagmails.daemon';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BIN = path.join(ROOT, 'target/release/tagmails-daemon');

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[char]);
}

function string(value) { return `<string>${escapeXml(value)}</string>`; }

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith('--')) {
    throw new Error(`Pass a value for ${name}`);
  }
  return process.argv[index + 1];
}

function existingAbsolute(value, label, type) {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute`);
  const resolved = fs.realpathSync(value);
  const stat = fs.statSync(resolved);
  if (type === 'directory' && !stat.isDirectory()) throw new Error(`${label} must be a directory`);
  if (type === 'file' && !stat.isFile()) throw new Error(`${label} must be a file`);
  return { path: resolved, stat };
}

function relayUrl(value) {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && local && url.port))
    || url.pathname !== '/' || url.search || url.hash || url.username || url.password) {
    throw new Error('Relay URL must be HTTPS, or an explicit localhost HTTP port');
  }
  return url.origin;
}

function plist(config) {
  const vars = Object.entries(config.environment).map(([key, value]) => `    <key>${key}</key>${string(value)}`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key>${string(LABEL)}
  <key>ProgramArguments</key><array>${string(config.binary)}${string('--watch')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>WorkingDirectory</key>${string(ROOT)}
  <key>EnvironmentVariables</key><dict>
${vars}
  </dict>
  <key>StandardOutPath</key>${string(config.stdout)}
  <key>StandardErrorPath</key>${string(config.stderr)}
</dict></plist>\n`;
}

function main() {
  const preview = process.argv.includes('--print');
  if (process.platform !== 'darwin' && !preview) throw new Error('LaunchAgent installation requires macOS');
  const relay = relayUrl(option('--relay'));
  const workspace = existingAbsolute(option('--workspace'), 'Workspace', 'directory');
  const token = existingAbsolute(option('--token-file'), 'Device token', 'file');
  const binary = existingAbsolute(process.argv.includes('--bin') ? option('--bin') : DEFAULT_BIN, 'Daemon binary', 'file');
  if (token.stat.uid !== process.getuid()) throw new Error('Device token file must belong to the current user');
  if ((token.stat.mode & 0o077) !== 0) throw new Error('Device token file must be accessible only by its owner');
  if (!/^tm_dev_[A-Za-z0-9_-]{43}\s*$/.test(fs.readFileSync(token.path, 'utf8'))) throw new Error('Device token file is invalid');
  fs.accessSync(binary.path, fs.constants.X_OK);
  const home = os.homedir();
  const logs = path.join(home, 'Library/Logs/TagMails');
  const config = {
    binary: binary.path,
    stdout: path.join(logs, 'daemon.log'),
    stderr: path.join(logs, 'daemon-error.log'),
    environment: {
      HOME: home,
      PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin',
      TAGMAILS_RELAY_URL: relay,
      TAGMAILS_DEVICE_TOKEN_FILE: token.path,
      TAGMAILS_WORKSPACE: workspace.path,
    },
  };
  const xml = plist(config);
  if (preview) { process.stdout.write(xml); return; }

  const directory = path.join(home, 'Library/LaunchAgents');
  const destination = path.join(directory, `${LABEL}.plist`);
  fs.mkdirSync(directory, { recursive: true });
  fs.mkdirSync(logs, { recursive: true, mode: 0o700 });
  const handle = fs.openSync(destination, 'wx', 0o600);
  try { fs.writeFileSync(handle, xml); }
  finally { fs.closeSync(handle); }
  try {
    execFileSync('plutil', ['-lint', destination], { stdio: 'pipe' });
    execFileSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, destination], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`LaunchAgent file saved at ${destination}, but it did not start: ${error.stderr?.toString().trim() || error.message}`);
  }
  process.stdout.write(`TagMails is watching the relay. LaunchAgent: ${destination}\nLogs: ${logs}\n`);
}

try { main(); }
catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
