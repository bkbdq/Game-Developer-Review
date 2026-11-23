const REDIRECTS = new Map([
  ['gdr-site.pages.dev', 'https://goodcorp.games'],
  ['gdr-site-dev.pages.dev', 'https://dev.goodcorp.games'],
  ['www.goodcorp.games', 'https://goodcorp.games'],
]);

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const target = REDIRECTS.get(url.host);
  if (!target) return context.next();
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') return context.next();
  return Response.redirect(target + url.pathname + url.search, 301);
}
