const OLD_HOST = 'gdr-admin.pages.dev';
const NEW_ORIGIN = 'https://admin.goodcorp.games';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.host !== OLD_HOST) return context.next();
  if (url.pathname.startsWith('/api/')) return context.next();
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') return context.next();
  return Response.redirect(NEW_ORIGIN + url.pathname + url.search, 301);
}
