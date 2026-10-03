const ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

function dotStuff(raw) {
  return raw.replace(/\r?\n/g, '\r\n').replace(/(^|\r\n)\./g, '$1..').replace(/\r\n?$/, '') + '\r\n.\r\n';
}

export async function sendRawResendEmail({ from, to, raw, apiKey, connect }) {
  if (!ADDRESS.test(from ?? '') || !ADDRESS.test(to ?? '') ||
      typeof raw !== 'string' || Buffer.byteLength(raw) > 64_000 ||
      !apiKey?.startsWith('re_')) throw new Error('Invalid SMTP message');
  const openSocket = connect ?? (await import('cloudflare:sockets')).connect;
  const socket = openSocket({ hostname: 'smtp.resend.com', port: 465 }, { secureTransport: 'on' });
  await socket.opened;
  const reader = socket.readable.getReader();
  const writer = socket.writable.getWriter();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = '';
  async function response(allowed) {
    let code;
    while (true) {
      let end = buffered.indexOf('\r\n');
      while (end < 0) {
        const part = await reader.read();
        if (part.done) throw new Error('SMTP closed unexpectedly');
        buffered += decoder.decode(part.value, { stream: true });
        if (buffered.length > 16_384) throw new Error('SMTP response is too large');
        end = buffered.indexOf('\r\n');
      }
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 2);
      const match = /^(\d{3})([ -])/.exec(line);
      if (!match || (code && code !== match[1])) throw new Error('Invalid SMTP response');
      code = match[1];
      if (match[2] === ' ') {
        if (!allowed.includes(Number(code))) throw new Error(`SMTP rejected message (${code})`);
        return;
      }
    }
  }
  async function command(value, allowed) {
    await writer.write(encoder.encode(`${value}\r\n`));
    await response(allowed);
  }
  try {
    await response([220]);
    await command('EHLO tagmails.com', [250]);
    await command(`AUTH PLAIN ${Buffer.from(`\0resend\0${apiKey}`).toString('base64')}`, [235]);
    await command(`MAIL FROM:<${from}>`, [250]);
    await command(`RCPT TO:<${to}>`, [250, 251]);
    await command('DATA', [354]);
    await writer.write(encoder.encode(dotStuff(raw)));
    await response([250]);
    try { await command('QUIT', [221]); } catch { /* The message was accepted before QUIT. */ }
    return { accepted: true };
  } finally {
    reader.releaseLock();
    writer.releaseLock();
    socket.close();
  }
}
