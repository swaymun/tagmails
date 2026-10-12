#!/usr/bin/env node
// Set up or update a self-hosted TagMails relay on Cloudflare. Safe to rerun:
// it creates only what is missing, keeps saved values, and redeploys.
//
//   node scripts/self-host-setup.mjs
//
// It writes two git-ignored files in the repo root: wrangler.selfhost.jsonc
// (from wrangler.selfhost.example.jsonc) and .env.selfhost (the Worker's
// secrets, mode 600). Values come from environment variables of the same
// name, then .env.selfhost, then a prompt. Secret values are never printed.
//
// Environment (all optional; prompted for when missing and stdin is a TTY):
//   WORKER_NAME        default tagmails-selfhost (also names the D1 database and R2 bucket)
//   MAIL_PROVIDER      cloudflare (default: Email Routing + Email Sending) or resend
//   AGENT_DOMAIN, PILOT_OWNER_EMAIL, GOOGLE_CLIENT_ID, PUBLIC_ORIGIN,
//   TYPESAFE_API_KEY, RESEND_API_KEY, RESEND_WEBHOOK_SECRET
//   SETUP_MAIL_ROUTING yes to let the script enable Email Routing and Sending
//                      on AGENT_DOMAIN (replaces that domain's MX records)

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
process.chdir(ROOT);

const CONFIG = 'wrangler.selfhost.jsonc';
const EXAMPLE = 'wrangler.selfhost.example.jsonc';
const SECRETS = '.env.selfhost';
const WRANGLER = 'node_modules/.bin/wrangler';
const PENDING = { GOOGLE_CLIENT_ID: 'pending', RESEND_WEBHOOK_SECRET: 'whsec_placeholder', PUBLIC_ORIGIN: 'https://pending.invalid' };
const RESEND_EVENTS = 'email.received, email.sent, email.delivered, email.delivery_delayed, email.bounced, email.failed, email.suppressed';
const interactive = process.stdin.isTTY && process.stdout.isTTY;

function fail(message) {
  console.error(`\nStopped: ${message}`);
  process.exit(1);
}

function wrangler(args, { show = false, input } = {}) {
  const result = spawnSync(WRANGLER, args, {
    encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (show) process.stdout.write(output);
  return { ok: result.status === 0, output };
}

async function ask(question, { hidden = false } = {}) {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  if (hidden) rl._writeToOutput = (text) => { if (text.includes(question)) process.stdout.write(text); };
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  if (hidden) process.stdout.write('\n');
  return answer.trim();
}

function readSecrets() {
  if (!existsSync(SECRETS)) return {};
  return Object.fromEntries(readFileSync(SECRETS, 'utf8').split('\n')
    .map((line) => line.match(/^([A-Z0-9_]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2]]));
}

function writeSecrets(values) {
  const body = Object.entries(values).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('\n');
  writeFileSync(SECRETS, `${body}\n`, { mode: 0o600 });
  chmodSync(SECRETS, 0o600);
}

function readConfig(path) {
  const text = readFileSync(path, 'utf8').split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  try { return JSON.parse(text); } catch { fail(`${path} is not plain JSON with // comment lines; fix it by hand or delete it to regenerate.`); }
}

// A value from the environment, then the saved file, then a prompt.
async function value(saved, name, question, { hidden = false, optional = false, placeholder, check } = {}) {
  const fromEnv = process.env[name]?.trim();
  if (fromEnv) return fromEnv;
  if (saved[name] && saved[name] !== placeholder) return saved[name];
  if (!interactive) {
    if (placeholder) return saved[name] ?? placeholder;
    if (optional) return undefined;
    fail(`${name} is not set. Export it or run this script in a terminal.`);
  }
  for (;;) {
    const answer = await ask(`${question}: `, { hidden });
    if (!answer && placeholder) return saved[name] ?? placeholder;
    if (!answer && optional) return undefined;
    if (answer && (!check || check(answer))) return answer;
    console.log(answer ? 'That value does not look right.' : 'A value is required.');
  }
}

async function main() {
  if (!existsSync(WRANGLER)) fail('Wrangler is not installed. Run `npm ci` in the repo root first.');
  const who = wrangler(['whoami']);
  if (!who.ok || /not authenticated/i.test(who.output)) fail('Wrangler is not logged in. Run `npx wrangler login` (or export CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID).');

  // 1. Config file.
  const firstRun = !existsSync(CONFIG);
  let config;
  if (firstRun) {
    config = readConfig(EXAMPLE);
    const worker = process.env.WORKER_NAME?.trim() || (interactive && await ask('Worker name [tagmails-selfhost]: ')) || 'tagmails-selfhost';
    if (!/^[a-z0-9-]{1,54}$/.test(worker)) fail('WORKER_NAME may use lowercase letters, digits and dashes only.');
    let provider = process.env.MAIL_PROVIDER?.trim() || (interactive && await ask('Mail provider, cloudflare or resend [cloudflare]: ')) || 'cloudflare';
    if (!['cloudflare', 'resend'].includes(provider)) fail('MAIL_PROVIDER must be cloudflare or resend.');
    config.name = worker;
    config.d1_databases[0].database_name = worker;
    config.r2_buckets[0].bucket_name = `${worker}-mail`;
    config.vars = { CLAUDE_ROUTE_ENABLED: 'true' };
    // Received mail over Resend is off unless the relay opts in (Cloudflare checks senders itself).
    if (provider === 'resend') config.vars.RESEND_INBOUND_ENABLED = 'true';
    if (provider === 'cloudflare') {
      config.send_email = [{ name: 'EMAIL' }];
      config.secrets = { required: ['GOOGLE_CLIENT_ID', 'AGENT_DOMAIN', 'PUBLIC_ORIGIN', 'PILOT_OWNER_EMAIL'] };
    }
  } else {
    config = readConfig(CONFIG);
    console.log(`Using the existing ${CONFIG}.`);
  }
  const worker = config.name;
  const database = config.d1_databases[0].database_name;
  const bucket = config.r2_buckets[0].bucket_name;
  const provider = config.send_email?.length ? 'cloudflare' : 'resend';

  // 2. Secrets.
  const saved = readSecrets();
  const firstSecrets = !existsSync(SECRETS);
  const secrets = { ...saved };
  secrets.AGENT_DOMAIN = await value(saved, 'AGENT_DOMAIN', 'Agent mail domain (agent addresses are name@this domain)',
    { check: (v) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(v) });
  secrets.PILOT_OWNER_EMAIL = (await value(saved, 'PILOT_OWNER_EMAIL', 'Owner Gmail address (only this account can sign in)',
    { check: (v) => /^[^@\s]+@gmail\.com$/i.test(v) })).toLowerCase();
  secrets.GOOGLE_CLIENT_ID = await value(saved, 'GOOGLE_CLIENT_ID', 'Google OAuth client ID (blank to add after the first deploy)',
    { placeholder: PENDING.GOOGLE_CLIENT_ID, check: (v) => v.endsWith('.apps.googleusercontent.com') });
  secrets.PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN?.trim() || saved.PUBLIC_ORIGIN || PENDING.PUBLIC_ORIGIN;
  if (!secrets.STORAGE_KEY) secrets.STORAGE_KEY = randomBytes(32).toString('base64');
  if (provider === 'resend') {
    secrets.RESEND_API_KEY = await value(saved, 'RESEND_API_KEY', 'Resend API key (sending and receiving access)', { hidden: true });
    secrets.RESEND_WEBHOOK_SECRET = await value(saved, 'RESEND_WEBHOOK_SECRET', 'Resend webhook signing secret (blank until the webhook exists)',
      { hidden: true, placeholder: PENDING.RESEND_WEBHOOK_SECRET });
  }
  if (firstSecrets || process.env.TYPESAFE_API_KEY) {
    secrets.TYPESAFE_API_KEY = await value(saved, 'TYPESAFE_API_KEY', 'TypeSafe API key for Jev routing (optional, blank to skip)',
      { hidden: true, optional: true });
  }
  writeSecrets(secrets);
  console.log(`Saved secrets to ${SECRETS} (git-ignored). Keep STORAGE_KEY: sealed mail can't be read without it.`);

  // 3. D1 and R2.
  const list = () => JSON.parse(wrangler(['d1', 'list', '--json']).output.replace(/^[^[]*/s, '') || '[]');
  let db = list().find((row) => row.name === database);
  if (!db) {
    console.log(`Creating D1 database ${database}...`);
    if (!wrangler(['d1', 'create', database], { show: true }).ok) fail('Could not create the D1 database.');
    db = list().find((row) => row.name === database);
  }
  if (!db?.uuid) fail(`Could not find the D1 database ${database}.`);
  if (firstRun || config.d1_databases[0].database_id !== db.uuid) {
    config.d1_databases[0].database_id = db.uuid;
    writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
    console.log(`Wrote ${CONFIG} (git-ignored).`);
  }
  if (!wrangler(['r2', 'bucket', 'info', bucket]).ok) {
    console.log(`Creating R2 bucket ${bucket}...`);
    if (!wrangler(['r2', 'bucket', 'create', bucket], { show: true }).ok) fail('Could not create the R2 bucket.');
  }

  // 4. Migrations and deploy.
  console.log('Applying D1 migrations...');
  if (!wrangler(['d1', 'migrations', 'apply', database, '--remote', '--config', CONFIG], { show: true }).ok) fail('Migrations failed.');
  console.log('Deploying the Worker...');
  const deploy = wrangler(['deploy', '--config', CONFIG, '--secrets-file', SECRETS], { show: true });
  if (!deploy.ok) fail('Deploy failed. A message about a rate limit namespace_id means 1001 or 1002 is taken in your account; change it in the config.');
  const url = deploy.output.match(/https:\/\/[a-z0-9.-]+\.workers\.dev/i)?.[0];
  if (secrets.PUBLIC_ORIGIN === PENDING.PUBLIC_ORIGIN) {
    if (!url) fail('Could not read the Worker URL from the deploy output. Set PUBLIC_ORIGIN and rerun.');
    secrets.PUBLIC_ORIGIN = url;
    writeSecrets(secrets);
    if (!wrangler(['secret', 'put', 'PUBLIC_ORIGIN', '--config', CONFIG], { input: url }).ok) fail('Could not set PUBLIC_ORIGIN.');
  }
  const origin = secrets.PUBLIC_ORIGIN;

  // 5. Cloudflare mail, only with consent: enabling Email Routing replaces the domain's MX records.
  const domain = secrets.AGENT_DOMAIN;
  let routed = false;
  if (provider === 'cloudflare') {
    const consent = process.env.SETUP_MAIL_ROUTING === 'yes' || (interactive && !process.env.SETUP_MAIL_ROUTING &&
      /^y/i.test(await ask(`Enable Email Routing and Sending on ${domain} and route all its mail to ${worker}? This replaces ${domain}'s MX records [y/N]: `)));
    if (consent) {
      const steps = [
        ['email', 'routing', 'enable', domain],
        ['email', 'routing', 'rules', 'update', domain, 'catch-all', '--action-type', 'worker', '--action-value', worker, '--enabled'],
        ['email', 'sending', 'enable', domain],
      ];
      routed = steps.every((args) => {
        const result = wrangler(args);
        console.log(`${result.ok ? 'ok    ' : 'failed'} wrangler ${args.join(' ')}`);
        if (!result.ok) console.log(result.output.trim().split('\n').slice(-3).join('\n'));
        return result.ok;
      });
    }
  }

  // 6. Checks.
  const check = async (label, path, init, expected) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const status = (await fetch(`${origin}${path}`, init)).status;
        if (status === expected || attempt === 4) return console.log(`${status === expected ? 'ok    ' : 'failed'} ${label}: HTTP ${status}, expected ${expected}`);
      } catch { if (attempt === 4) return console.log(`failed ${label}: ${origin} did not answer`); }
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  };
  console.log('\nChecks:');
  const googleReady = secrets.GOOGLE_CLIENT_ID !== PENDING.GOOGLE_CLIENT_ID;
  await check('sign-in config', '/api/auth/config', undefined, 200);
  await check('device API rejects unpaired calls', '/api/device/claim', { method: 'POST' }, 401);

  // 7. What's left.
  const next = [];
  if (!googleReady) next.push(`Create a Google Cloud OAuth client (Web application) with authorized JavaScript origin ${origin}, then rerun this script and paste its client ID.`);
  else next.push(`Make sure ${origin} is an authorized JavaScript origin of your Google OAuth client.`);
  if (provider === 'cloudflare' && !routed) {
    next.push(`Mail for ${domain}: in the Cloudflare dashboard enable Email Routing, add a catch-all rule "Send to a Worker" -> ${worker}, and enable Email Sending for ${domain}. Or rerun with SETUP_MAIL_ROUTING=yes.`);
  }
  if (provider === 'resend' && secrets.RESEND_WEBHOOK_SECRET === PENDING.RESEND_WEBHOOK_SECRET) {
    next.push(`In Resend, add a webhook to ${origin}/webhooks/resend for: ${RESEND_EVENTS}. Rerun this script and paste its signing secret.`);
  }
  next.push(`Sign in at ${origin}/account as ${secrets.PILOT_OWNER_EMAIL} and create a pairing code.`);
  next.push(`On your Mac or Linux machine: tagmails pair <code> --relay ${origin} && tagmails start --projects`);
  next.push('Email the agent address shown on the account page from that Gmail account.');
  console.log(`\nRelay: ${origin}\n\nNext:\n${next.map((step, i) => `  ${i + 1}. ${step}`).join('\n')}`);
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
