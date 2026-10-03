export async function knownAgentAddresses(db, addresses) {
  const candidates = [...new Set(addresses)];
  if (!candidates.length) return new Set();
  const placeholders = candidates.map(() => '?').join(', ');
  const rows = await db.prepare(`SELECT email FROM account_agent_addresses
    WHERE email IN (${placeholders})`).bind(...candidates).all();
  return new Set((rows.results ?? rows).map((row) => row.email));
}
