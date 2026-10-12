#!/usr/bin/env node
// One-off purge of mail content the relay can still open: everything in R2
// that is not sealed to a computer (TMDEV1), and the relay-readable copies in
// D1 (thread subjects, held "which project?" request text, reply subjects and
// file names). Relay-written answers (model/project questions, failure
// notices) contain no mail and are kept.
//
//   node scripts/purge-relay-key-data.mjs            # dry run: counts only
//   node scripts/purge-relay-key-data.mjs --apply    # delete
//
// Needs `npx wrangler login`; runs against the dev relay's D1 and R2.
import { execFileSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const DATABASE = 'tagmails-relay-dev';
const BUCKET = 'tagmails-relay-mail-dev';
const RELAY_WRITTEN = /\/(model-clarification|unavailable|abandoned)\.json$/;

const wrangler = (args) => execFileSync('npx', ['wrangler', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const token = wrangler(['auth', 'token']).trim().split('\n').at(-1);
const account = JSON.parse(wrangler(['whoami', '--json']) || '{}').accounts?.[0]?.id
  ?? wrangler(['whoami']).match(/[0-9a-f]{32}/)?.[0];
if (!token || !account) throw new Error('Run `npx wrangler login` first');
const api = (path, init = {}) => fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/r2/buckets/${BUCKET}${path}`,
  { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });

function d1(sql) {
  const out = JSON.parse(wrangler(['d1', 'execute', DATABASE, '--remote', '--env', 'dev', '--json', '--command', sql]));
  return out[0]?.results ?? [];
}

async function listObjects() {
  const keys = [];
  let cursor = '';
  do {
    const response = await (await api(`/objects?per_page=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json();
    if (!response.success) throw new Error(`R2 listing failed: ${JSON.stringify(response.errors)}`);
    keys.push(...response.result.map((object) => object.key));
    cursor = response.result_info?.cursor ?? '';
  } while (cursor);
  return keys;
}

async function deviceSealed(key) {
  const response = await api(`/objects/${key.split('/').map(encodeURIComponent).join('/')}`, { headers: { Range: 'bytes=0-5' } });
  if (!response.ok) throw new Error(`R2 read failed for ${key}: ${response.status}`);
  const head = Buffer.from(await response.arrayBuffer()).subarray(0, 6).toString('latin1');
  return head === 'TMDEV1';
}

const doomed = [];
let kept = 0;
for (const key of await listObjects()) {
  if (RELAY_WRITTEN.test(key) || await deviceSealed(key)) { kept += 1; continue; }
  doomed.push(key);
}
const byPrefix = Object.entries(Object.groupBy(doomed, (key) => key.split('/')[0])).map(([prefix, keys]) => `${prefix}: ${keys.length}`);
console.log(`R2: ${doomed.length} relay-readable objects (${byPrefix.join(', ') || 'none'}), ${kept} kept`);

const d1Fixes = [
  [`threads with a relay-readable subject`, `SELECT COUNT(*) AS n FROM threads WHERE subject != '' AND subject NOT LIKE 'dev:v1:%'`,
    `UPDATE threads SET subject = '' WHERE subject != '' AND subject NOT LIKE 'dev:v1:%'`],
  [`jobs holding "which project?" request text`, `SELECT COUNT(*) AS n FROM jobs WHERE json_type(workspace_json, '$.pending') IS NOT NULL`,
    `UPDATE jobs SET workspace_json = NULL WHERE json_type(workspace_json, '$.pending') IS NOT NULL`],
  [`replies with a stored subject, body or file names`, `SELECT COUNT(*) AS n FROM outbox WHERE json_type(payload_json, '$.subject') IS NOT NULL
      OR json_type(payload_json, '$.html') IS NOT NULL OR json_type(payload_json, '$.text') IS NOT NULL OR json_type(payload_json, '$.attachments') IS NOT NULL`,
    `UPDATE outbox SET payload_json = json_remove(payload_json, '$.subject', '$.html', '$.text', '$.attachments', '$.bodyStored')
      WHERE json_type(payload_json, '$.subject') IS NOT NULL OR json_type(payload_json, '$.html') IS NOT NULL
        OR json_type(payload_json, '$.text') IS NOT NULL OR json_type(payload_json, '$.attachments') IS NOT NULL`],
];
for (const [label, count] of d1Fixes) console.log(`D1: ${d1(count)[0].n} ${label}`);

if (!APPLY) {
  console.log('Dry run. Re-run with --apply to delete.');
  process.exit(0);
}

for (const key of doomed) {
  const response = await api(`/objects/${key.split('/').map(encodeURIComponent).join('/')}`, { method: 'DELETE' });
  if (!response.ok) throw new Error(`R2 delete failed for ${key}: ${response.status}`);
}
// Rows that pointed at deleted objects now say so.
const quoted = (keys) => keys.map((key) => `'${key.replace(/'/g, "''")}'`).join(', ');
for (let index = 0; index < doomed.length; index += 50) {
  const batch = quoted(doomed.slice(index, index + 50));
  d1(`UPDATE messages SET raw_deleted_at = COALESCE(raw_deleted_at, CURRENT_TIMESTAMP) WHERE object_key IN (${batch})`);
  d1(`UPDATE jobs SET result_key = NULL WHERE result_key IN (${batch})`);
  d1(`DELETE FROM run_artifacts WHERE object_key IN (${batch})`);
}
for (const [, , fix] of d1Fixes) d1(fix);
console.log(`Deleted ${doomed.length} R2 objects and cleared the D1 copies.`);
