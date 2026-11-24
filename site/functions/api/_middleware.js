import { originAllowed } from '../_lib/public.js';

const METHODS = 'GET, POST, OPTIONS';
const HEADERS = 'Content-Type, Accept';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': METHODS,
    'Access-Control-Allow-Headers': HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export async function onRequest(context) {
  const origin = context.request.headers.get('Origin');
  const allowed = Boolean(origin) && originAllowed(context.request, context.env);

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { status: allowed ? 204 : 403, headers: allowed ? corsHeaders(origin) : {} });
  }

  const response = await context.next();
  if (!allowed) return response;

  const headers = new Headers(response.headers);
  Object.entries(corsHeaders(origin)).forEach(([key, value]) => headers.set(key, value));
  return new Response(response.body, { status: response.status, headers });
}
