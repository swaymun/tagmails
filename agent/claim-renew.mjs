import fs from 'node:fs/promises';

export async function renewClaim(claim) {
  let url = `${(process.env.TAGMAILS_LAB_URL || 'http://127.0.0.1:4177').replace(/\/+$/, '')}/api/renew`;
  const headers = { 'Content-Type': 'application/json' };
  let body = { jobId: claim.jobId, claimId: claim.claimId };
  if (process.env.TAGMAILS_RELAY_URL) {
    const file = process.env.TAGMAILS_DEVICE_TOKEN_FILE;
    if (!file) throw new Error('Device token file is missing');
    const token = (await fs.readFile(file, 'utf8')).trim();
    url = `${process.env.TAGMAILS_RELAY_URL.replace(/\/+$/, '')}/api/device/renew`;
    headers.Authorization = `Bearer ${token}`;
    body = { jobId: claim.jobId, leaseId: claim.claimId };
  }
  const response = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok || !(await response.json()).renewed) throw new Error('Claim renewal failed');
}
