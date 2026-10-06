// One Durable Object per account holds its computers' WebSockets. The relay
// pokes it when mail becomes claimable, so idle daemons stop polling every
// few seconds. Sockets hibernate between messages, and "ping" is answered by
// the runtime without waking the object.

const MAX_SOCKETS = 20;

export class DevicePush {
  constructor(ctx) {
    this.ctx = ctx;
    // Absent in Node tests; the runtime always provides it.
    if (globalThis.WebSocketRequestResponsePair) {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/notify') {
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.send('{"type":"jobs"}'); } catch { /* closing socket */ }
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname !== '/connect' || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Not found', { status: 404 });
    }
    const deviceId = request.headers.get('x-tagmails-device');
    if (!deviceId) return new Response('Missing device', { status: 400 });
    // A daemon restart can leave its previous socket open until it times out.
    const sockets = this.ctx.getWebSockets();
    for (const socket of [...this.ctx.getWebSockets(deviceId), ...sockets.slice(0, Math.max(0, sockets.length - MAX_SOCKETS + 1))]) {
      try { socket.close(1000, 'Replaced'); } catch { /* already closed */ }
    }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [deviceId]);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage() {}

  webSocketClose(socket, code) {
    try { socket.close(code === 1005 || code === 1006 ? 1000 : code, 'Closed'); } catch { /* already closed */ }
  }

  webSocketError() {}
}

function stub(env, accountId) {
  return env.DEVICE_PUSH.get(env.DEVICE_PUSH.idFromName(accountId));
}

export function openDevicePush(request, env, device) {
  if (!env.DEVICE_PUSH) return Response.json({ error: 'Push is not configured' }, { status: 404 });
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ error: 'WebSocket upgrade required' }, { status: 426 });
  }
  const headers = new Headers({ upgrade: 'websocket', 'x-tagmails-device': device.id });
  for (const name of ['sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  return stub(env, device.account_id).fetch('https://device-push/connect', { headers });
}

// Best effort: a missed notice is picked up by the daemon's slow fallback poll.
export async function notifyDevices(env, accountId) {
  if (!env.DEVICE_PUSH || !accountId) return;
  try { await stub(env, accountId).fetch('https://device-push/notify', { method: 'POST' }); }
  catch { console.error('Device push notice is delayed'); }
}
