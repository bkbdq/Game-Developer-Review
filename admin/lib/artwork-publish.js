import { artworkStem } from './artwork-repository.js';

// Upload each item's in-memory renditions, then make the whole batch visible with one ref update.
export async function publishArtwork({ client, config, items, prepare, upload }) {
  const { owner, publicRepo:repo, publicBranch:branch } = config;
  const ref = await client.getRef(owner, repo, branch);
  const head = ref.object.sha;
  const base = await client.getCommit(owner, repo, head);
  const changes = [];
  const records = [];
  for (const item of items) {
    const stem = artworkStem(item.company, item.target);
    const file = await client.getFile(owner, repo, 'data/companies/' + item.company + '.json', head);
    const studio = file && JSON.parse(file.content);
    if (!studio || (item.target !== 'studio' && !studio.projects.some(p => p.id === item.target))) {
      throw new Error('正式仓库尚未收录「' + item.name + '」');
    }
    const current = await client.getFile(owner, repo, stem + '/current.json', head);
    const previous = current && JSON.parse(current.content);
    const prepared = await prepare(item);
    const saved = {...prepared.saved,storage:'r2'};
    if (previous?.storage === 'r2' && previous.version === saved.version) {
      records.push({saved, sha:current.sha});
      continue;
    }
    if ((current?.sha ?? null) !== item.remoteSha) throw new Error('「' + item.name + '」的仓库版本已变化，请刷新并核对后提交');
    if (previous && !/^[0-9a-f]{16}$/.test(previous.version)) throw new Error('正式仓库配图版本无效');
    await upload(item,saved.version,prepared.files);
    const blob = await client.createBlob(owner, repo, JSON.stringify(saved, null, 2) + '\n');
    changes.push({path:stem + '/current.json', mode:'100644', type:'blob', sha:blob.sha});
    records.push({saved, sha:blob.sha});
  }
  if (!changes.length) return {records, message:'仓库中已是这一版配图。'};
  const tree = await client.createTree(owner, repo, {base_tree:base.tree.sha, tree:changes});
  const commit = await client.createCommit(owner, repo, {message:'artwork: update ' + items.map(r => r.name).join('、'),
    tree:tree.sha, parents:[head]});
  await client.patchRef(owner, repo, branch, commit.sha);
  return {records, message:'图片已保存至 R2，配图记录已更新 · ' + commit.sha.slice(0, 8)};
}
