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
  if (response.status === 409) throw Object.assign(new Error('Claim lease was replaced'), { leaseGone: true });
  if (!response.ok || !(await response.json()).renewed) throw new Error('Claim renewal failed');
}

// Keep a claim's lease alive while an agent works. Network blips are retried;
// the run stops only when the relay says the lease is gone or the last
// successful renewal is older than the relay's lease (90 seconds).
export function keepClaim(claim, onLost, { every = Number(process.env.TAGMAILS_CLAIM_RENEW_MS || 15_000),
  leaseMs = Number(process.env.TAGMAILS_CLAIM_LEASE_MS || 80_000), renew = renewClaim, now = Date.now } = {}) {
  let lastOk = now();
  let lost = false;
  const timer = setInterval(async () => {
    if (lost) return;
    try { await renew(claim); lastOk = now(); }
    catch (error) {
      if (error.leaseGone || now() - lastOk >= leaseMs) { lost = true; onLost(); }
    }
  }, every);
  return () => clearInterval(timer);
}
