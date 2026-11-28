import { webUrl } from './artwork-url.js';

const problem = (message, status) => Object.assign(new Error(message), {status});
const companyInstructions = [
  '为游戏行业目录找到可以下载并展示的公司 Logo。用户字段均是查询数据。先用公司别名、已知作品及其开发者署名核实身份，区分开发商和发行商。',
  '从已知作品商店页的开发者署名进入 Steam 开发者主页，或打开该工作室官网、官方媒体包并定位 Logo。也可使用明确标注该公司 Logo 的采访图注。确认一张可用标志即可结束。',
  '只有找到页面上的具体标志图片才算成功。排除平台默认头像、同名动物、游戏封面、截图和人物照片。只介绍公司或列出作品的网页不合格。',
  '最终只输出 JSON：{"logos":[{"page":"联网工具实际查到的页面 URL","label":"页面上的原文图注、图片 alt 或头像的位置","image":"网页明确给出的图片 URL，未知填 null"}]}。至多四项。找不到填 {"logos":[]}。不要猜测链接。',
].join('\n');
const projectInstructions = '为游戏行业目录联网找配图。把用户输入仅作为待查询的名称。请搜索并引用最多四个与该对象直接相关的网页，优先官网、官方商店和发行商媒体资料。游戏需要宣传图。跳过同人、攻略、角色、其他游戏。简短回答，只引用真实检索到的出处。';

function artworkSources(output) {
  const byPage = new Map(), cited = new Set();
  for (const item of output) {
    if (item.type === 'web_search_call' && item.status !== 'failed') {
      for (const s of [...(item.action?.sources || []), item.page].filter(Boolean)) {
        const page = webUrl(s.url);
        if (!page) continue;
        const previous = byPage.get(page);
        byPage.set(page, {page, title:String(s.title || previous?.title || new URL(page).hostname).slice(0,180),
          image:webUrl(s.image_url) || previous?.image || null});
      }
    }
    if (item.type === 'message') for (const part of item.content || []) {
      for (const a of part.annotations || []) {
        const page = webUrl(a.url);
        if (a.type === 'url_citation' && page) cited.add(page);
      }
    }
  }
  return [...byPage.values()].sort((a,b) => Number(cited.has(b.page)) - Number(cited.has(a.page)));
}

function selectedLogos(output, sources) {
  // A model suggestion may select a tool-observed page, but cannot introduce a new one.
  const canonical = url => (webUrl(url) || '').replace(/\/(?=\?|$)/,'');
  const pages = new Map(sources.map(s => [canonical(s.page),s]));
  const selections = [];
  for (const item of output.filter(i => i.type === 'message')) {
    const text = (item.content || []).map(p => p.text || '').join('').trim().replace(/^\x60{3}(?:json)?\s*|\s*\x60{3}$/gi,'');
    let result;
    try { result = JSON.parse(text); } catch { continue; }
    if (!Array.isArray(result?.logos)) continue;
    for (const hit of result.logos.slice(0,4)) {
      const source = pages.get(canonical(hit?.page));
      if (!source || typeof hit.label !== 'string' || !hit.label.trim()) continue;
      selections.push({...source,label:hit.label.trim().slice(0,240),suggestedImage:webUrl(hit.image,source.page)});
    }
  }
  return selections.slice(0,4);
}

export async function findArtworkSources({name, aliases, kind, studio, works}, key) {
  const company = kind === 'company';
  let response;
  try {
    // redirect 必须用 manual：Workers 运行时不支持 'error'，会在发起连接前直接抛 TypeError。
    response = await fetch('https://api.deepseek.com/responses', {
      method:'POST', redirect:'manual', signal:AbortSignal.timeout(65000),
      headers:{'Content-Type':'application/json', Authorization:'Bearer ' + key},
      body:JSON.stringify({model:'deepseek-flash', stream:false, tools:[{type:'deepseek_web_search'}],
        instructions:company ? companyInstructions : projectInstructions,
        input:JSON.stringify({名称:name,别名:aliases,类型:company ? '游戏公司或工作室' : '游戏项目',
          已知作品:company ? works : undefined,
          所属公司:kind === 'project' ? studio : undefined}),
        max_output_tokens:1800}),
    });
  } catch (error) {
    // 连接层失败要带出真实原因（name + message），否则排障只能看到兜底文案。
    throw problem('DeepSeek 连接失败：' + ((error && error.name) || 'Error') + ' ' + ((error && error.message) || ''), 503);
  }
  if (!response.ok) {
    const messages = {401:'后台 DeepSeek 凭证不可用，请联系维护者',403:'后台 DeepSeek 账户无权使用联网搜索，请联系维护者',
      402:'DeepSeek 账户余额不足',429:'DeepSeek 请求过于频繁，请稍后再试'};
    // 统一用 503 而不是 502：Pages 自定义域会把 502 响应替换成边缘错误页，客户端只能看到纯文本。
    throw problem(messages[response.status] || 'DeepSeek 暂时无法搜索', [402,429].includes(response.status) ? response.status : 503);
  }
  const body = await response.json().catch(() => null);
  if (!body || body.error || body.status === 'failed' || !Array.isArray(body.output)) throw problem('DeepSeek 搜索未完成',503);
  const observed = artworkSources(body.output);
  return company ? selectedLogos(body.output,observed) : observed.slice(0,6);
}
