import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function bindings() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_inbound.sql', '0002_devices_and_leases.sql', '0003_outbound_and_reactions.sql', '0004_accounts_and_pairing.sql']) {
    sqlite.exec(fs.readFileSync(new URL(`./migrations/${file}`, import.meta.url), 'utf8'));
  }
  sqlite.prepare('INSERT INTO accounts (id, google_sub, owner_email, agent_email) VALUES (?, ?, ?, ?)')
    .run('account-1', 'google-sub-1', 'owner@gmail.com', 'agent@wonder.test');
  const db = {
    prepare(sql) {
      return {
        bind(...args) {
          const statement = sqlite.prepare(sql);
          return { first: async () => statement.get(...args) ?? null, all: async () => ({ results: statement.all(...args) }), run: async () => statement.run(...args) };
        },
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
  };
  const objects = new Map();
  const env = {
    DB: db, MAIL: {
      put: async (key, value) => objects.set(key, Buffer.from(value)),
      get: async (key) => objects.has(key) ? { arrayBuffer: async () => Uint8Array.from(objects.get(key)).buffer } : null,
    },
    RESEND_API_KEY: 're_test', RESEND_WEBHOOK_SECRET: 'whsec_test', AGENT_ADDRESS: 'agent@wonder.test',
  };
  return { env, sqlite, objects };
}
