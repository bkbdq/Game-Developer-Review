const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/;
const ALLOWED_ORIGINS = new Set(['https://admin.goodcorp.games', 'https://gdr-admin.pages.dev']);

function corsHeaders(origin) {
  const headers = new Headers();
  if (origin && (ALLOWED_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin))) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Vary', 'Origin');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    headers.set('Access-Control-Max-Age', '86400');
  }
  return headers;
}

export async function onRequest(context) {
  const origin = context.request.headers.get('Origin');
  const headers = corsHeaders(origin);
  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }
  const response = await context.next();
  const output = new Response(response.body, response);
  headers.forEach((value, key) => output.headers.set(key, value));
  return output;
}
