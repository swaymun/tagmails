// Thread-to-session maps shared by runner processes. Several jobs can finish
// at once, so every write re-reads the file under a lock and applies only its
// own change; writing a stale snapshot would drop another thread's session.
import fs from 'node:fs/promises';
import path from 'node:path';

const STALE_LOCK_MS = 30_000;

export async function readStore(file, label = 'session') {
  try {
    const value = JSON.parse(await fs.readFile(file, 'utf8'));
    if (value.version !== 1 || !value.threads || !value.jobs) throw new Error(`Unsupported ${label} store`);
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, threads: {}, jobs: {} };
    throw error;
  }
}

async function locked(file, work) {
  const lock = `${file}.lock`;
  let handle;
  for (let attempt = 0; !handle; attempt++) {
    try { handle = await fs.open(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST' || attempt > 400) throw error;
      const stat = await fs.stat(lock).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > STALE_LOCK_MS) await fs.rm(lock, { force: true });
      else await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  try { return await work(); }
  finally { await handle.close(); await fs.rm(lock, { force: true }); }
}

export async function updateStore(file, change, label = 'session') {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  return locked(file, async () => {
    const store = await readStore(file, label);
    change(store);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(store, null, 2), { mode: 0o600 });
    await fs.rename(temporary, file);
    return store;
  });
}
