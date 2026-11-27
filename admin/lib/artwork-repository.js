import { config } from '../config.js';

export const artworkStem = (company, target) => 'site/public/images/catalog/' + company + '/' + target;
export const artworkUrl = (item, version, key) => '/api/artwork/' + [item.company,item.target,version,key + '.webp'].join('/');

// Resolve both metadata and originals against the same tree, even if main moves during editing.
export async function readArtworkRepository(local, token, fetchImpl = fetch) {
  const { owner, publicRepo, publicBranch } = config;
  const base = 'https://api.github.com/repos/' + owner + '/' + publicRepo;
  async function get(path, accept) {
    const headers = { Accept: accept };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetchImpl(base + path, { headers, cache:'no-cache', signal:AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('读取 GitHub 仓库失败（HTTP ' + res.status + '）');
    return res;
  }
  const tree = await (await get('/git/trees/' + publicBranch + '?recursive=1','application/vnd.github+json')).json();
  if (tree.truncated || !Array.isArray(tree.tree)) throw new Error('仓库目录不完整，请重试');
  const paths = new Map(tree.tree.filter(f => f.type === 'blob').map(f => [f.path, f.sha]));
  const blob = sha => get('/git/blobs/' + sha, 'application/vnd.github.raw+json');
  const metadata = new Map();
  async function manifest(sha) {
    if (!metadata.has(sha)) {
      const saved = await (await blob(sha)).json();
      if (!/^[0-9a-f]{16}$/.test(saved.version)) throw new Error('配图记录版本无效');
      metadata.set(sha,saved);
    }
    return metadata.get(sha);
  }
  const localByCompany = new Map();
  for (const entry of local) {
    if (!localByCompany.has(entry.company)) localByCompany.set(entry.company, []);
    localByCompany.get(entry.company).push(entry);
  }
  const rows = [];
  for (const [path,sha] of paths) {
    const company = /^data\/companies\/(c_[a-z0-9_-]+)\.json$/.exec(path)?.[1];
    if (!company) continue;
    const cached = localByCompany.get(company) || [];
    let companyRows = cached;
    if (cached[0]?.companySha !== sha) {
      const c = await (await blob(sha)).json();
      companyRows = [{id:'studio',name:c.name}, ...c.projects].map(p => ({
        company, studio:c.name, target:p.id, name:p.name, kind:p.id === 'studio' ? 'company' : 'project',
        draft:cached.find(e => e.target === p.id)?.draft,
      }));
    }
    for (const e of companyRows) {
      const stem = artworkStem(company,e.target);
      const remoteSha = paths.get(stem + '/current.json') || null;
      rows.push({...e,remoteSha,thumbnail:null});
    }
  }
  const configured = rows.filter(row => row.remoteSha);
  for (let i=0;i<configured.length;i+=6) {
    // A failed thumbnail lookup must leave the rest of the directory available.
    await Promise.allSettled(configured.slice(i,i+6).map(async row => {
      const saved = await manifest(row.remoteSha);
      const card = artworkStem(row.company,row.target) + '/' + saved.version + '-card.webp';
      row.thumbnail = saved.storage === 'r2' ? artworkUrl(row,saved.version,'card')
        : paths.has(card) ? `https://raw.githubusercontent.com/${owner}/${publicRepo}/${publicBranch}/${card}` : null;
    }));
  }
  return {
    rows:rows.sort((a,b) => a.name.localeCompare(b.name, 'zh-CN')),
    async original(e) {
      const saved = await manifest(e.remoteSha);
      if (saved.storage === 'r2') {
        const response = await fetchImpl(artworkUrl(e,saved.version,'source'));
        if (!response.ok || response.headers.get('content-type')?.split(';')[0] !== 'image/webp') throw new Error('无法读取 R2 中的配图原图');
        return {saved,file:await response.blob()};
      }
      const source = paths.get(artworkStem(e.company,e.target) + '/' + saved.version + '-source.webp');
      if (!source || !/^[0-9a-f]{16}$/.test(saved.version)) throw new Error('仓库中的配图记录缺少原图');
      const file = await (await blob(source)).blob();
      return { saved, file:new Blob([file], {type:'image/webp'}) };
    },
  };
}
