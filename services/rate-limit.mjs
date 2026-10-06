// Per-IP limits for unauthenticated routes, using Workers rate limiting
// bindings (see wrangler.jsonc). PUBLIC_RATE_LIMIT covers pages and webhooks;
// AUTH_RATE_LIMIT covers sign-in, pairing and failed credentials. A missing
// binding, or a limiter error, means no limit: mail intake must not stop.

const PUBLIC_PATHS = [/^\/account$/, /^\/runs\//, /^\/api\/runs\//, /^\/api\/auth\/config$/, /^\/webhooks\/resend$/];

export function publicPath(pathname) {
  return PUBLIC_PATHS.some((pattern) => pattern.test(pathname));
}

export async function rateLimited(env, binding, request, scope) {
  const limiter = env[binding];
  if (typeof limiter?.limit !== 'function') return false;
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  try { return !(await limiter.limit({ key: `${scope}:${ip}` })).success; }
  catch { return false; }
}

export function tooManyRequests(headers = {}) {
  return Response.json({ error: 'Too many requests. Try again in a minute.' }, { status: 429, headers: {
    'Retry-After': '60', 'Cache-Control': 'no-store', ...headers,
  } });
}
