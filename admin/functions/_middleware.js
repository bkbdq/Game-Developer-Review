const OLD_HOST = 'gdr-admin.pages.dev';
const NEW_ORIGIN = 'https://admin.goodcorp.games';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (url.host !== OLD_HOST) {
    const response = await context.next();
    if (url.pathname.startsWith('/api/')) return response;
    // 审核台每次部署都要求浏览器协商缓存，避免继续使用旧版脚本
    const output = new Response(response.body, response);
    output.headers.set('Cache-Control', 'no-cache');
    return output;
  }
  if (url.pathname.startsWith('/api/')) return context.next();
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') return context.next();
  return Response.redirect(NEW_ORIGIN + url.pathname + url.search, 301);
}
