// Per-IP limits for unauthenticated routes, using Workers rate limiting
// bindings (see wrangler.jsonc). PUBLIC_RATE_LIMIT covers pages and webhooks;
// AUTH_RATE_LIMIT covers sign-in, pairing and failed credentials (site, device
// and MCP alike). A signed-in MCP account is limited by account, not IP. A missing
// binding, or a limiter error, means no limit: mail intake must not stop.

const PUBLIC_PATHS = [/^\/account$/, /^\/runs\//, /^\/api\/runs\//, /^\/api\/auth\/config$/, /^\/webhooks\/resend$/,
  /^\/\.well-known\/oauth-/, /^\/oauth\/(?:authorize|register|revoke)$/];

export function publicPath(pathname) {
  return PUBLIC_PATHS.some((pattern) => pattern.test(pathname));
}

export async function rateLimited(env, binding, request, scope) {
  return rateLimitedKey(env, binding, `${scope}:${request.headers.get('cf-connecting-ip') || 'unknown'}`);
}

export async function rateLimitedKey(env, binding, key) {
  const limiter = env[binding];
  if (typeof limiter?.limit !== 'function') return false;
  try { return !(await limiter.limit({ key })).success; }
  catch { return false; }
}

export function tooManyRequests(headers = {}) {
  return Response.json({ error: 'Too many requests. Try again in a minute.' }, { status: 429, headers: {
    'Retry-After': '60', 'Cache-Control': 'no-store', ...headers,
  } });
}
