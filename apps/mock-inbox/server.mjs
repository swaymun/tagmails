import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Lab } from './lab.mjs';
import { escapeHtml } from './mail.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const dataFile = process.env.WONDER_EMAIL_LAB_DATA ?? path.resolve(directory, '../../.local/mock-inbox.json');
const port = Number(process.env.WONDER_EMAIL_LAB_PORT ?? 4177);
const lab = new Lab(dataFile, { origin: `http://127.0.0.1:${port}` });

const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/landing/', ['../landing/index.html', 'text/html; charset=utf-8']],
  ['/landing/style.css', ['../landing/style.css', 'text/css; charset=utf-8']],
  ['/landing/app.js', ['../landing/app.js', 'text/javascript; charset=utf-8']],
  ['/samples/image-email.eml', ['fixtures/image-email.eml', 'message/rfc822']],
]);

function response(res, status, content, type = 'text/plain; charset=utf-8', extra = {}) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  });
  res.end(content);
}

function json(res, status, value) {
  response(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 128_000) throw new Error('The test email is too large for this lab');
  }
  try { return JSON.parse(body || '{}'); }
  catch { throw new Error('Request body is not valid JSON'); }
}

async function readEmail(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 5 * 1024 * 1024) throw new Error('The .eml file is larger than 5 MB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function tracePage(id) {
  const job = lab.state.jobs.find((item) => item.id === id);
  if (!job) return null;
  const thread = lab.state.threads.find((item) => item.id === job.threadId);
  const events = lab.state.events.filter((item) => item.jobId === id).slice().reverse();
  const rows = events.map((item) => `<li><time>${escapeHtml(item.at)}</time><strong>${escapeHtml(item.type)}</strong><span>${escapeHtml(item.description)}</span></li>`).join('');
  const realAgent = ['codex-cli-readonly', 'codex-app-server-readonly', 'claude-cli-readonly'].includes(job.runtime);
  const agent = job.runtime === 'claude-cli-readonly' ? 'Claude' : 'Codex';
  const label = realAgent ? `Local ${agent} run` : 'Simulated run';
  const notice = realAgent
    ? `${job.state === 'completed' ? `${agent} completed in read-only mode against the selected local workspace.` : `The local ${agent} route did not complete.`} This fixture did not use a real email provider.`
    : 'This is an internal fixture. No model ran, no code changed, and no external action occurred.';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${label} · ${escapeHtml(id)}</title><style>body{font:16px/1.6 Arial,sans-serif;color:#202124;max-width:760px;margin:48px auto;padding:0 24px}a{color:#1a73e8}h1{font-size:28px}small{color:#5f6368}ul{list-style:none;padding:0}li{display:grid;grid-template-columns:180px 110px 1fr;gap:12px;padding:12px 0;border-bottom:1px solid #dadce0}time{font-size:12px;color:#5f6368}.notice{background:#fef7e0;padding:14px 18px;border-radius:8px}@media(max-width:650px){li{grid-template-columns:1fr;gap:0}}</style></head><body><a href="/">← Back to inbox</a><h1>${label}</h1><p class="notice">${notice}</p><p><strong>Thread:</strong> ${escapeHtml(thread.subject)}<br><strong>Route:</strong> ${escapeHtml(job.model.id ?? 'unresolved')} ${escapeHtml(job.model.effort ?? '')}<br><strong>Status:</strong> ${escapeHtml(job.state)}</p><h2>Events</h2><ul>${rows}</ul><small>Local test data, visible only on this computer.</small></body></html>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === 'GET' && staticFiles.has(url.pathname)) {
      const [name, type] = staticFiles.get(url.pathname);
      const content = fs.readFileSync(path.join(directory, name));
      response(res, 200, content, type, { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; base-uri 'none'; object-src 'none'" });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/state') { json(res, 200, lab.snapshot()); return; }
    if (req.method === 'GET' && url.pathname === '/api/mime') {
      const found = lab.findMessage(url.searchParams.get('messageId'));
      response(res, found?.message.mime ? 200 : 404, found?.message.mime ?? 'Raw MIME is available for generated replies only', 'text/plain; charset=utf-8');
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/attachment') {
      const item = lab.attachment(url.searchParams.get('messageId'), url.searchParams.get('attachmentId'));
      if (!item) { response(res, 404, 'Attachment not found'); return; }
      const disposition = item.previewable ? 'inline' : 'attachment';
      response(res, 200, item.bytes, item.previewable ? item.mimeType : 'application/octet-stream', {
        'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(item.name)}`,
        'Content-Security-Policy': "default-src 'none'; base-uri 'none'; form-action 'none'",
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/preview') {
      const content = lab.preview(url.searchParams.get('messageId'));
      response(res, content ? 200 : 404, content ?? 'Message not found', 'text/html; charset=utf-8', { 'Content-Security-Policy': "sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; base-uri 'none'; form-action 'none'" });
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/trace/')) {
      const content = tracePage(url.pathname.slice('/trace/'.length));
      response(res, content ? 200 : 404, content ?? 'Run not found', 'text/html; charset=utf-8', { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" });
      return;
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      const expectedOrigin = `http://127.0.0.1:${port}`;
      if (req.headers.origin && req.headers.origin !== expectedOrigin) { json(res, 403, { error: 'This lab only accepts actions from its own page' }); return; }
      if (url.pathname === '/api/import') {
        if (req.headers['content-type'] !== 'message/rfc822') { json(res, 415, { error: 'Expected a raw .eml file' }); return; }
        json(res, 200, await lab.importMime(await readEmail(req)));
        return;
      }
      if (!req.headers['content-type']?.startsWith('application/json')) { json(res, 415, { error: 'Expected a JSON request' }); return; }
      const data = await readJson(req);
      let result;
      switch (url.pathname) {
        case '/api/send': result = lab.send(data); break;
        case '/api/daemon': lab.setOnline(data.online); result = { online: lab.state.online }; break;
        case '/api/process': result = lab.processNext(); break;
        case '/api/heartbeat': lab.heartbeat(); result = { online: true }; break;
        case '/api/claim': result = lab.claimNext(data.jobId); break;
        case '/api/renew': result = lab.renewClaim(data.jobId, data.claimId); break;
        case '/api/complete': result = lab.completeClaim(data.jobId, data.claimId, data.result); break;
        case '/api/guest': result = lab.guestAction(data.threadId, data.email, data.action); break;
        case '/api/react': result = lab.react(data); break;
        case '/api/approve': lab.approveJob(data.jobId); result = { approved: true }; break;
        case '/api/reset': lab.reset(); result = { reset: true }; break;
        default: json(res, 404, { error: 'Unknown lab action' }); return;
      }
      json(res, 200, result);
      return;
    }
    response(res, 404, 'Not found');
  } catch (error) {
    json(res, 400, { error: error.message });
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`TagMails internal Gmail lab: http://127.0.0.1:${port}\n`);
});
