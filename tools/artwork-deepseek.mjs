import { createHash } from 'node:crypto';
import { encodeCandidate, sourceImage } from './artwork-web.mjs';
import { companyWorks, downloadImage, lookupNames, searchArtwork } from './artwork-sources.mjs';

import { findArtworkSources } from '../admin/functions/_lib/deepseek-sources.js';

const cache = new Map();
const pending = new Map();
const problem = (message, status) => Object.assign(new Error(message), {status});
async function sharedSources(query, token) {
  const params = new URLSearchParams({name:query.name, kind:query.kind, studio:query.studio});
  for (const alias of query.aliases) params.append('alias',alias);
  for (const work of query.works) params.append('work',work);
  const response = await fetch('https://admin.goodcorp.games/api/admin/artwork-search?' + params, {
    method:'POST', redirect:'error', signal:AbortSignal.timeout(85000),
    headers:{Authorization:'Bearer ' + token},
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw problem(result?.message || '正式后台的 DeepSeek 搜索暂时不可用',response.status);
  if (!Array.isArray(result?.sources)) throw problem('正式后台未返回有效的图片来源',502);
  return result.sources;
}

export async function discoverArtwork(term, kind, studio, key, resolveImage = sourceImage, works = [], reviewerToken = null) {
  const names = lookupNames(term,kind);
  const companyNames = kind === 'company' ? [...new Set([names.name,term,...names.aliases])] : null;
  const query = {name:names.name, aliases:names.aliases, kind, studio, works};
  const sources = key ? await findArtworkSources(query,key) : await sharedSources(query,reviewerToken);
  const candidates = [], seen = new Set();
  for (let i=0; i<sources.length && candidates.length<4; i+=2) {
    const photos = await Promise.allSettled(sources.slice(i,i+2).map(source => resolveImage({...source,companyNames})));
    for (const p of photos) {
      if (p.status !== 'fulfilled' || !p.value || seen.has(p.value.image) || candidates.length>=4) continue;
      seen.add(p.value.image);
      candidates.push(p.value);
    }
  }
  return {candidates};
}

export function deepSeekArtwork(term, kind, studio, key, listedWorks = [], reviewerToken = null) {
  if (!key && !reviewerToken) throw problem('请登录审核台使用团队共享的 DeepSeek 找图',401);
  if (key && (key.length > 512 || !/^[\x21-\x7e]+$/.test(key))) throw problem('后台尚未配置可用的 DeepSeek 凭证，请联系维护者',503);
  const works = kind === 'company' ? companyWorks(term,studio,listedWorks) : [];
  const id = JSON.stringify([createHash('sha256').update(key || reviewerToken).digest('hex'), key ? 'local' : 'shared',term,kind,studio,works]);
  const cached = cache.get(id);
  if (cached?.until > Date.now()) return cached.result;
  if (pending.has(id)) return pending.get(id);
  const work = discoverArtwork(term,kind,studio,key,sourceImage,works,reviewerToken).then(async result => {
    if (!result.candidates.length) {
      const regular = await searchArtwork(term, kind);
      const images = await Promise.allSettled(regular.candidates.slice(0,4).map(async candidate => {
        const {bytes} = await downloadImage(candidate.image);
        return encodeCandidate(candidate, bytes);
      }));
      result.candidates = images.flatMap(r => r.status === 'fulfilled' && r.value ? [r.value] : []);
    }
    if (result.candidates.length) {
      if (cache.size >= 8) cache.delete(cache.keys().next().value);
      cache.set(id, {result, until:Date.now()+600000});
    }
    return result;
  }).finally(() => pending.delete(id));
  pending.set(id,work);
  return work;
}
