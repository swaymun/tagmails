import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readStore, updateStore } from './session-store.mjs';

test('parallel runners each keep their own thread session', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tagmails-store-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'sessions.json');
  await updateStore(file, (store) => { store.threads.old = { sessionId: 's-old', workspace: '/w' }; });
  // Separate processes, like concurrent runner jobs.
  const script = path.join(root, 'writer.mjs');
  await fs.writeFile(script, `import { updateStore } from ${JSON.stringify(new URL('./session-store.mjs', import.meta.url).href)};
const id = process.argv[2];
await updateStore(process.argv[3], (store) => { store.threads[id] = { sessionId: 's-' + id, workspace: '/w' }; store.jobs['job-' + id] = { state: 'completed' }; });`);
  await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise((resolve, reject) => {
    fork(script, [`t${index}`, file]).on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`writer ${index} exited ${code}`))));
  })));
  const store = await readStore(file);
  assert.equal(Object.keys(store.threads).length, 9);
  assert.equal(Object.keys(store.jobs).length, 8);
  await assert.rejects(fs.stat(`${file}.lock`), { code: 'ENOENT' });
});
