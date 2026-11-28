import { readFileSync } from 'node:fs';
import { Parser } from 'htmlparser2';
import { isBaikeImage } from '../admin/lib/baike-image.js';

const aliases = JSON.parse(readFileSync(new URL('../admin/lib/aliases.json', import.meta.url), 'utf8'));

const profiles = JSON.parse(readFileSync(new URL('./company-logo-sources.json', import.meta.url), 'utf8'));
const verifiedImages = new Map(profiles.map(p => [p.image, p]));

const agent = 'goodcorp-artwork/1.0 (+https://goodcorp.games/)';
const maxBytes = 12 * 1024 * 1024;
const imageHosts = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org', 'static.pc.yyb.qq.com', 'pp.myapp.com',
  'avatars.cdn.queniuqe.com','avatars.st.dl.eccdnx.com']);
export const onlineProviders = ['公司标志', 'Steam', 'TapTap', '腾讯应用宝', '百度百科', '英文维基百科', '维基共享资源', 'DeepSeek'];
const clean = s => s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}]/gu, '');

export function lookupNames(term, kind) {
  const rows = kind === 'company' ? aliases.companies : aliases.projects;
  const row = rows.find(row => [row.name, ...row.aliases].some(name => clean(name) === clean(term)));
  const english = row?.aliases.find(name => /^[\x20-\x7e]{4,}$/.test(name));
  return { name: row?.name || term, english: english || (/^[\x20-\x7e]+$/.test(term) ? term : ''), aliases:row?.aliases || [] };
}

export function companyWorks(name, studio, listed) {
  const canonical = lookupNames(name,'company').name;
  const sameCompany = clean(canonical) === clean(lookupNames(studio,'company').name);
  if (sameCompany && listed.length) return [...new Set(listed)].slice(0,5);
  return aliases.projects.filter(p => p.company === canonical).slice(0,5).map(p => p.name);
}

export async function limitedBytes(stream, limit = maxBytes) {
  let size = 0;
  const parts = [];
  for await (const part of stream) {
    size += part.length;
    if (size > limit) throw new Error('文件过大，请选择 12 MB 以内的图片');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

function allowedImage(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      (verifiedImages.has(value) || isBaikeImage(value) ||
        imageHosts.has(u.hostname) || u.hostname.endsWith('.tapimg.com') || u.hostname.endsWith('.steamstatic.com') ||
        u.hostname.endsWith('.steamusercontent.com'));
  } catch {
    return false;
  }
}

export async function downloadImage(value) {
  if (!allowedImage(value)) throw new Error('图片地址不属于支持的来源');
  const response = await fetch(value, {
    redirect: 'error', headers: { 'User-Agent': agent }, signal: AbortSignal.timeout(15000),
  });
  if (response.ok && verifiedImages.has(value)) {
    const profile = verifiedImages.get(value);
    const {default: sharp} = await import('sharp');
    const bytes = await limitedBytes(response.body);
    let image = sharp(bytes, {density:144, limitInputPixels:40000000});
    if (profile.background) image = image.flatten({background:profile.background});
    return {bytes:await image.resize({width:1600,height:1000,fit:'inside',withoutEnlargement:true}).png().toBuffer(),mime:'image/png'};
  }
  const mime = response.headers.get('content-type')?.split(';')[0];
  if (!response.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
    throw new Error('来源未返回可用图片，请换一张');
  }
  return { bytes: await limitedBytes(response.body), mime };
}

async function query(base, params) {
  const url = new URL(base);
  url.search = new URLSearchParams(params);
  const response = await fetch(url, {
    headers: { 'User-Agent': agent }, signal: AbortSignal.timeout(9500),
  });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  return response.json();
}

async function steam({ name, english }, studio) {
  const find = async term => {
    const search = await query('https://store.steampowered.com/api/storesearch/', { term, l: 'schinese', cc: 'cn' });
    const matches = search.items.filter(item => Number.isSafeInteger(item.id) &&
      [name, english].some(v => v && clean(item.name).includes(clean(v))));
    const exact = matches.filter(item => [name, english].some(v => v && clean(item.name) === clean(v)));
    return (exact.length ? exact : matches).slice(0, 3);
  };
  let apps = await find(name);
  if (!apps.length && english && english !== name) apps = await find(english);
  if (!apps.length) return [];
  const first = apps[0];
  const page = id => 'https://store.steampowered.com/app/' + id + '/';
  const capsules = apps.map(app => ({
    provider: 'Steam', title: app.name, page: page(app.id), image: app.tiny_image,
  }));
  try {
    const info = await query('https://store.steampowered.com/api/appdetails', { appids: first.id, l: 'schinese', cc: 'cn' });
    const game = info[first.id]?.data;
    if (game?.header_image) capsules[0].image = game.header_image;
    if (studio && [name, english].some(n => n && clean(n) === clean(first.name))) {
      const identity = lookupNames(studio, 'company');
      const credits = [...(game?.developers || []), ...(game?.publishers || [])].map(clean);
      if ([studio,identity.name,...identity.aliases].some(n => credits.includes(clean(n)))) capsules[0].batchMatch = true;
    }
    const shots = (game?.screenshots ?? []).slice(0, 2).map((shot, i) => ({
      provider: 'Steam', title: first.name + ' · 截图 ' + (i + 1), page: page(first.id), image: shot.path_full,
    }));
    return [capsules[0], ...shots, ...capsules.slice(1)];
  } catch {
    return capsules;
  }
}

async function steamDeveloper({ name, english, aliases }) {
  const names = [name, english, ...aliases].filter(Boolean);
  const slugs = [...new Set(names.filter(n => /^[A-Za-z0-9][A-Za-z0-9 _-]{2,79}$/.test(n)).map(n => n.replace(/\s/g,'')))];
  for (const slug of slugs.slice(0,2)) {
    const page = 'https://store.steampowered.com/developer/' + encodeURIComponent(slug) + '/';
    const res = await fetch(page + '?l=english', {redirect:'manual', headers:{'User-Agent':agent}, signal:AbortSignal.timeout(8000)});
    if (!res.ok || !res.headers.get('content-type')?.includes('text/html')) { await res.body?.cancel(); continue; }
    const html = (await limitedBytes(res.body, 2 * 1024 * 1024)).toString('utf8');
    let profile = '', image = '';
    new Parser({onopentag(tag, a) {
      if (tag === 'meta' && a.property === 'og:title') profile = /^Steam Developer:\s*(.+)$/i.exec(a.content || '')?.[1] || '';
      if (tag === 'img' && a.class?.split(/\s+/).includes('curator_avatar')) image = a.src || '';
    }}).end(html);
    if (!profile || !names.some(n => clean(n) === clean(profile)) || !allowedImage(image)) continue;
    const avatar = new URL(image);
    if (avatar.hostname.startsWith('avatars.') && /^\/[0-9a-f]{40}_full\.jpg$/i.test(avatar.pathname)) {
      return [{provider:'Steam',title:profile + ' · 开发者头像',page,image}];
    }
  }
  return [];
}

async function tapTap({ name, english }) {
  const result = await query('https://www.taptap.cn/webapiv2/search/v2/app', {
    kw: name, 'X-UA':'V=1&PN=WebApp&LANG=zh_CN&VN=0.1.0&VN_CODE=100000000&PLT=PC',
  });
  if (!Array.isArray(result.data?.list)) throw new Error('TapTap 搜索不可用');
  const games = result.data.list.map(row => row.app).filter(game => Number.isSafeInteger(game?.id) &&
    typeof game.title === 'string' && [name, english].some(title => title && clean(title) === clean(game.title)));
  return games.slice(0, 2).flatMap(game => {
    const fields = [[game.banner || game.top_banner || game.ad_banner,'横幅'], [game.cover,'封面'],
      [game.cover_vertical,'竖版海报'], [game.icon,'图标']];
    return fields.filter(([art]) => art?.original_url || art?.url).map(([art, label]) => ({
      provider:'TapTap', title:game.title + ' · ' + label, page:'https://www.taptap.cn/app/' + game.id,
      image:art.original_size > maxBytes ? art.url : (art.original_url || art.url),
    }));
  });
}

async function appStore({ name }) {
  const url = new URL('https://sj.qq.com/search');
  url.searchParams.set('q', name);
  const response = await fetch(url, { headers: { 'User-Agent': agent }, signal: AbortSignal.timeout(9500) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const html = (await limitedBytes(response.body, 5 * 1024 * 1024)).toString('utf8');
  const embedded = html.match(/<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  const components = embedded && JSON.parse(embedded[1]).props?.pageProps?.dynamicCardResponse?.data?.components;
  if (!Array.isArray(components)) throw new Error('应用宝搜索页暂不可读取');
  const items = components.flatMap(c => c.data?.itemData || []);
  // 商店还会返回其他推荐游戏，只取命中游戏名的条目。
  const games = items.filter(item => item.name && clean(item.name) === clean(name) && /^[\w.]+$/.test(item.pkg_name || ''));
  return games.flatMap(game => {
    const page = 'https://sj.qq.com/appdetail/' + game.pkg_name;
    const shots = (game.audited_snapshots || '').split(',').filter(Boolean).slice(0, 5);
    return [...shots.map((image, i) => ({ provider:'腾讯应用宝', title:game.name + ' · 商店截图 ' + (i+1), page, image })),
      { provider:'腾讯应用宝', title:game.name + ' · 图标', page, image:(game.icon || '').replace(/^http:/, 'https:') }];
  });
}

async function baike(name, apiKey) {
  const url = new URL('https://appbuilder.baidu.com/v2/baike/lemma/get_content');
  url.search = new URLSearchParams({ search_type:'lemmaTitle', search_key:name });
  const response = await fetch(url, { redirect:'error', headers:{Authorization:'Bearer ' + apiKey}, signal:AbortSignal.timeout(9500) });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const {code, result} = await response.json();
  if (code != null && String(code) !== '0') throw new Error('百科接口返回错误');
  if (!result?.lemma_title) return [];
  const image = result.pic_url || result.square_pic_url;
  if (!isBaikeImage(image)) return [];
  const page = 'https://baike.baidu.com/item/' + encodeURIComponent(result.lemma_title) +
    (Number.isSafeInteger(result.lemma_id) && result.lemma_id > 0 ? '/' + result.lemma_id : '');
  const title = [result.lemma_title, result.lemma_desc].filter(Boolean).join(' · ').slice(0, 180);
  return [{provider:'百度百科', title, page, image}];
}

async function englishWiki(name, kind) {
  const titles = name + '|' + name + (kind === 'company' ? ' (company)' : ' (video game)');
  const result = await query('https://en.wikipedia.org/w/api.php', {
    action: 'query', format: 'json', formatversion: 2, titles, converttitles: 1, redirects: 1,
    prop: 'pageimages|info', inprop: 'url', pithumbsize: 960, pilicense: 'any',
  });
  if (result.error) throw new Error(result.error.code);
  return (result.query?.pages ?? [])
    .filter(page => page.thumbnail).map(page => ({
      provider: '英文维基百科', title: page.title, page: page.fullurl, image: page.thumbnail.source,
    }));
}

async function commons(name) {
  const result = await query('https://commons.wikimedia.org/w/api.php', {
    action:'query', format:'json', formatversion:2, generator:'search', gsrnamespace:6,
    gsrsearch:name + ' logo', gsrlimit:8, prop:'imageinfo', iiprop:'url|mime', iiurlwidth:960,
  });
  if (result.error) throw new Error(result.error.code);
  return (result.query?.pages ?? []).flatMap(page => {
    const info = page.imageinfo?.[0];
    const title = page.title.replace(/^File:/, '');
    if (!info?.mime?.startsWith('image/') || !clean(title).includes(clean(name)) || !/logo|标志|標誌|商标|商標/i.test(title)) return [];
    return [{ provider:'维基共享资源', title, page:info.descriptionurl, image:info.thumburl || info.url }];
  });
}

const cache = new Map();
async function modelChoice(term, kind, candidates) {
  const model = process.env.GOODCORP_ART_MODEL;
  if (!model || !candidates.length) return null;
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method:'POST', signal:AbortSignal.timeout(45000), headers:{'Content-Type':'application/json'},
    body:JSON.stringify({model, stream:false, options:{temperature:0},
      messages:[
        {role:'system', content:'为游戏行业目录筛选素材。根据对象名称、类型、候选标题和出处判断归属。公司要公司自身，项目优先同一游戏的官方商店图。不要选择关联人物、续作或 DLC。返回最可靠候选的零起始编号，不能确定返回 -1。'},
        {role:'user', content:JSON.stringify({term, kind, candidates:candidates.map((c,index) => ({index,title:c.title,source:c.provider,page:c.page}))})},
      ], format:{type:'object',properties:{index:{type:'integer',minimum:-1,maximum:candidates.length-1}},required:['index']}}),
  });
  if (!response.ok) throw new Error('模型不可用');
  const {index} = JSON.parse((await response.json()).message.content);
  if (!Number.isInteger(index) || index < -1 || index >= candidates.length) throw new Error('模型选择无效');
  return index;
}

export async function searchArtwork(term, kind, studio = '', quick = false) {
  const baikeKey = process.env.BAIDU_BAIKE_API_KEY?.trim();
  const key = JSON.stringify([term, kind, studio, quick, Boolean(baikeKey)]);
  const cached = cache.get(key);
  if (cached?.until > Date.now()) return cached.result;
  const names = lookupNames(term, kind);
  const profile = kind === 'company' && profiles.find(p => [term,names.name].some(n => clean(n) === clean(p.name)));
  const brand = profile && {provider:'公司标志',title:profile.name + ' · Logo',page:profile.page,image:profile.image,batchMatch:true};
  if (brand && quick) return {candidates:[brand],warnings:[],choice:null,lookup:names.name,baikeConfigured:Boolean(baikeKey)};
  const providers = kind === 'company'
    ? [['Steam', () => steamDeveloper(names)], ['维基共享资源', () => commons(names.english || names.name)]]
    : [['Steam', () => steam(names, studio)], ['TapTap', () => tapTap(names)], ['腾讯应用宝', () => appStore(names)]];
  if (baikeKey) providers.push(['百度百科', () => baike(names.name, baikeKey)]);
  if (names.english) providers.push(['英文维基百科', () => englishWiki(names.english, kind)]);
  const responses = await Promise.allSettled(providers.map(([, search]) => search()));
  const warnings = [];
  const candidates = brand ? [brand] : [];
  const seen = new Set(brand ? [brand.image] : []);
  responses.forEach((response, i) => {
    if (response.status === 'rejected') warnings.push(providers[i][0] === '百度百科'
      ? '百度百科接口请求失败，可打开词条选图' : providers[i][0] + ' 暂时无法连接');
    else for (const item of response.value) {
      if (!allowedImage(item.image)) continue;
      const asset = new URL(item.image);
      for (const k of [...asset.searchParams.keys()]) if (k.startsWith('utm_')) asset.searchParams.delete(k);
      if (seen.has(asset.href)) continue;
      seen.add(asset.href);
      candidates.push(item);
    }
  });
  for (const c of candidates) {
    if (kind === 'company' && (['Steam','维基共享资源'].includes(c.provider) ||
        (c.provider === '英文维基百科' && clean(c.title) === clean(names.english || names.name) && /logo|wordmark/i.test(c.image)))) c.batchMatch = true;
    if (kind === 'project' && ['TapTap','腾讯应用宝'].includes(c.provider)) c.batchMatch = true;
  }
  // 优先展示商店封面和截图，方形图标排在最后。
  function rank(item) {
    if (item === brand) return -1;
    if (item.title.endsWith(' · 图标') || /\/capsule_231x87/i.test(item.image)) return 2;
    if (item.provider === 'Steam' && [names.name,names.english].some(s => s && clean(s) === clean(item.title))) return 0;
    return 1;
  }
  candidates.sort((a,b) => rank(a) - rank(b));
  let choice = null;
  try { choice = await modelChoice(term, kind, candidates); }
  catch { warnings.push('本机 AI 不可用，已按名称排序'); }
  if (choice > 0) candidates.unshift(...candidates.splice(choice, 1));
  const result = { candidates, warnings, choice, lookup: names.name, baikeConfigured: Boolean(baikeKey) };
  if (!warnings.length) {
    if (cache.size >= 200) cache.delete(cache.keys().next().value);
    cache.set(key, { until: Date.now() + 600000, result });
  }
  return result;
}
