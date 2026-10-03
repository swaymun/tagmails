import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import test from 'node:test';
import { stageAgentAttachments } from './agent-attachments.mjs';

test('local lab attachments are fetched into bounded temporary files', async (t) => {
  const bytes = Buffer.from('A small attached note.');
  const server = http.createServer((request, response) => {
    if (request.url !== '/api/attachment?messageId=mail-1&attachmentId=file-1') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' }).end(bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const previous = process.env.TAGMAILS_LAB_URL;
  process.env.TAGMAILS_LAB_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => {
    if (previous === undefined) delete process.env.TAGMAILS_LAB_URL;
    else process.env.TAGMAILS_LAB_URL = previous;
  });

  const staged = await stageAgentAttachments([{ name: 'note.txt', mimeType: 'text/plain',
    size: bytes.length, path: '/api/attachment?messageId=mail-1&attachmentId=file-1' }]);
  const file = `${staged.directory}/attachment-1.txt`;
  try {
    assert.deepEqual(await fs.readFile(file), bytes);
    assert.match(staged.prompt, /untrusted data/);
    assert.equal((await fs.stat(staged.directory)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally {
    await staged.cleanup();
  }
  await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  await assert.rejects(stageAgentAttachments([{ size: 3, mimeType: 'text/plain',
    path: '/api/attachment?messageId=mail-1&attachmentId=file-1' }]), /does not match/);
  await assert.rejects(stageAgentAttachments([{ size: 0, mimeType: 'text/plain',
    path: 'https://example.com/file' }]), /local lab/);
});
