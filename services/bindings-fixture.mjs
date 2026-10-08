import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export function bindings() {
  const sqlite = new DatabaseSync(':memory:');
  const migrations = fs.readdirSync(new URL('./migrations/', import.meta.url)).filter((file) => file.endsWith('.sql')).sort();
  for (const file of migrations) {
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
      // Like R2: streams are read whole, and a sha256 option must match the bytes.
      put: async (key, value, options = {}) => {
        const bytes = value instanceof ReadableStream ? Buffer.from(await new Response(value).arrayBuffer()) : Buffer.from(value);
        if (options.sha256 && createHash('sha256').update(bytes).digest('hex') !== options.sha256) throw new Error('Checksum mismatch');
        objects.set(key, bytes);
      },
      get: async (key) => objects.has(key) ? { arrayBuffer: async () => Uint8Array.from(objects.get(key)).buffer } : null,
      delete: async (key) => { objects.delete(key); },
    },
    RESEND_API_KEY: 're_test', RESEND_WEBHOOK_SECRET: 'whsec_test', CLAUDE_ROUTE_ENABLED: 'true',
    PUBLIC_SIGNUP_ENABLED: 'true',
  };
  return { env, sqlite, objects };
}
