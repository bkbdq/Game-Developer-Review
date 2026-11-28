import { authenticate, fail, json } from '../../_lib/auth.js';
import { findArtworkSources } from '../../_lib/deepseek-sources.js';

export async function onRequestPost({request, env}) {
  const session = await authenticate(request,env);
  if (session.error) return session.error;
  const params = new URL(request.url).searchParams;
  const name = params.get('name')?.trim();
  const kind = params.get('kind');
  const studio = params.get('studio') || '';
  const aliases = params.getAll('alias');
  const works = params.getAll('work');
  if ((request.body && !(await request.body.getReader().read()).done) ||
      [...params.keys()].some(k => !['name','kind','studio','alias','work'].includes(k)) ||
      !name || name.length > 100 || !['company','project'].includes(kind) || studio.length > 180 ||
      aliases.length > 20 || works.length > 5 || [...aliases,...works].some(s => !s.trim() || s.length > 160)) {
    return fail(400,'找图参数无效');
  }
  if (!env.DEEPSEEK_API_KEY) return fail(503,'正式审核后台尚未配置 DeepSeek 凭证');
  try {
    const sources = await findArtworkSources({name,kind,studio,aliases,works},env.DEEPSEEK_API_KEY);
    return json({sources});
  } catch (error) {
    if (error.status) return fail(error.status,error.message);
    // 503 而不是 502：Pages 自定义域会把 502 替换成边缘纯文本错误页，真实信息到不了客户端。
    return fail(503,'正式后台暂时无法连接 DeepSeek：' + ((error && error.message) || '未知错误'));
  }
}
