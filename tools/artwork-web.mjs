import { lookup } from 'node:dns/promises';
import { get } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Parser } from 'htmlparser2';
import sharp from 'sharp';

// These public publishers and stores can also be reached through a local DNS proxy's fake-IP range.
const storeDomains = ['taptap.cn','tapimg.com','steampowered.com','steamstatic.com','steamusercontent.com',
  'store.steamchina.com','shared.cdn.steamchina.eccdnx.com','gamespress.com','igdb.com','gamersky.com',
  'sj.qq.com','yyb.qq.com','pp.myapp.com','shared.cdn.queniuqe.com','shared.st.dl.eccdnx.com','kurogames.com','kurogame.com','gamesci.com.cn',
  'mihoyo.com','hoyoverse.com','hoyolab.com','hoyoverse.cn','yuanshen.com','youthcatgames.com','chuapp.com',
  'avatars.cdn.queniuqe.com','avatars.st.dl.eccdnx.com','www.nexarda.com','imgcdn1.nexarda.com'];
const proxyRange = ipaddr.parseCIDR('198.18.0.0/15');
export function webUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null;
  try {
    const u = new URL(value, base);
    if (u.protocol !== 'https:' || u.port || u.username || u.password || !u.hostname.includes('.') ||
        isIP(u.hostname) || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.local')) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}

// Pin the connection to a public address, including for every redirect.
function publicAddress(host, options, callback) {
  lookup(host, {family:4, all:true}).then(records => {
    const known = storeDomains.some(domain => host === domain || host.endsWith('.' + domain));
    const record = records.find(({address}) => {
      const ip = ipaddr.parse(address);
      return ip.range() === 'unicast' || (known && ip.match(proxyRange));
    });
    if (!record) return callback(new Error('来源地址不可访问'));
    if (options.all) callback(null, [record]);
    else callback(null, record.address, record.family);
  }, callback);
}

async function loadResource(address, type, limit) {
  let url = webUrl(address);
  const signal = AbortSignal.timeout(9000);
  for (let hop = 0; url && hop <= 3; hop++) {
    const response = await new Promise((resolve, reject) => {
      get(url, {agent:false, family:4, lookup:publicAddress, signal, headers:{
        'User-Agent':'goodcorp-artwork/1.0', Accept:type === 'html' ? 'text/html' : 'image/*',
      }}, resolve).on('error', reject);
    });
    try {
      if ([301,302,303,307,308].includes(response.statusCode)) {
        url = webUrl(response.headers.location, url);
        continue;
      }
      const mime = (response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (response.statusCode !== 200 || (type === 'html' ? mime !== 'text/html' : !mime.startsWith('image/'))) break;
      const parts = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > limit) throw new Error('来源文件过大');
        parts.push(chunk);
      }
      return {url, bytes:Buffer.concat(parts)};
    } finally { response.destroy(); }
  }
  throw new Error('来源未返回可用内容');
}

export async function encodeCandidate(source, bytes) {
  const pipeline = sharp(bytes, {limitInputPixels:40000000, failOn:'error'});
  const info = await pipeline.metadata();
  if (!['jpeg','png','webp','avif','heif','gif'].includes(info.format) || Math.min(info.width,info.height) < 100) return null;
  const webp = await pipeline.autoOrient().resize({width:2000,height:2000,fit:'inside',withoutEnlargement:true})
    .webp({quality:87}).toBuffer();
  if (webp.length > 2 * 1024 * 1024) return null;
  return {...source, webp:webp.toString('base64')};
}

export async function sourceImage(source, load = loadResource) {
  const attempted = new Set();
  const compact = s => s.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}]/gu,'');
  const company = (source.companyNames || []).map(compact).filter(Boolean);
  const brand = /(?:logo|标志|标识|商标|徽标)/i;
  const logoLabel = label => brand.test(label) && company.some(n => compact(label).includes(n));
  async function tryImage(url) {
    if (!url || attempted.has(url)) return null;
    attempted.add(url);
    try {
      const file = await load(url, 'image', 12 * 1024 * 1024);
      const title = company.length && source.label ? (source.companyNames[0] + ' · ' + source.label).slice(0,180) : source.title;
      return await encodeCandidate({provider:'DeepSeek', title, page:source.page, image:file.url}, file.bytes);
    } catch { return null; }
  }
  const imagePage = /\.(?:png|jpe?g|webp|avif)(?:\?|$)/i.test(source.page);
  if (!company.length || (imagePage && logoLabel(source.title || ''))) {
    const direct = await tryImage(imagePage ? source.page : webUrl(source.image));
    if (direct) return direct;
  }
  const page = await load(source.page, 'html', 3 * 1024 * 1024);
  const images = new Set();
  const logos = new Set();
  const siteLogos = new Set();
  let steamAvatar, downloadLabel = '', inSuggestedLink = false, logoDownload = false;
  let figure, inCaption = false, siteName = '', title = '';
  const parser = new Parser({onopentag(tag, a) {
    const key = (a.property || a.name || '').toLowerCase();
    if (tag === 'meta' && key === 'og:site_name') siteName = a.content || '';
    if (tag === 'meta' && key === 'og:title') title = a.content || '';
    if (company.length) {
      if (tag === 'a' && source.suggestedImage && webUrl(a.href,page.url) === source.suggestedImage) {
        inSuggestedLink = true;
        downloadLabel = [a.title,a['aria-label']].filter(Boolean).join(' ');
      }
      if (tag === 'figure') figure = {image:null,caption:''};
      if (tag === 'figcaption' && figure) inCaption = true;
      if (tag === 'img') {
        const image = webUrl((a['data-src'] || a.src || '').replace(/^http:\/\//i,'https://'), page.url);
        if (image && logoLabel(a.alt || a.title || '')) logos.add(image);
        if (image && brand.test([a.alt,a.title,a.class,new URL(image).pathname].join(' '))) siteLogos.add(image);
        if (image && a.class?.split(/\s+/).includes('curator_avatar')) steamAvatar = image;
        if (image && figure && !figure.image) figure.image = image;
      }
    }
    if (tag === 'meta' && ['og:image','og:image:secure_url','og:image:url','twitter:image','twitter:image:src'].includes(key)) {
      images.add(webUrl(a.content, page.url));
    } else if (tag === 'link' && (a.rel || '').toLowerCase().split(/\s+/).includes('image_src')) {
      images.add(webUrl(a.href, page.url));
    }
  }, ontext(s) {
    if (inCaption && figure) figure.caption += s;
    if (inSuggestedLink) downloadLabel += s;
  }, onclosetag(tag) {
    if (tag === 'a' && inSuggestedLink) {
      logoDownload ||= brand.test(downloadLabel);
      inSuggestedLink = false;
    }
    if (tag === 'figcaption') inCaption = false;
    if (tag === 'figure' && figure) {
      if (figure.image && logoLabel(figure.caption)) logos.add(figure.image);
      figure = null;
      inCaption = false;
    }
  }});
  parser.end(page.bytes.toString('utf8'));
  const steamName = /^Steam\s*(?:Developer|Publisher|开发者|開發者|发行商|發行商)\s*[:：]\s*(.+)/i.exec(title)?.[1];
  if (steamAvatar && steamName && company.includes(compact(steamName)) &&
      /^https:\/\/store\.steampowered\.com\/(?:developer|publisher|curator)\//i.test(page.url)) logos.add(steamAvatar);
  const matchingPage = [siteName,...title.split(/\s*[|｜]\s*/)].some(part => company.includes(compact(part)));
  if (matchingPage) {
    for (const image of siteLogos) logos.add(image);
    if (logoDownload) logos.add(source.suggestedImage);
    if (images.has(source.suggestedImage) && brand.test(source.label || '')) logos.add(source.suggestedImage);
  }
  const candidates = company.length ? logos : images;
  if (source.suggestedImage && candidates.has(source.suggestedImage)) {
    const suggested = await tryImage(source.suggestedImage);
    if (suggested) return suggested;
  }
  for (const url of [...candidates].filter(Boolean).slice(0,3)) {
    const photo = await tryImage(url);
    if (photo) return photo;
  }
  return null;
}
