function mergeCompanyFiles(base, incoming) {
  const merged = { ...base };
  const projects = new Map();
  for (const project of [...(base.projects || []), ...(incoming.projects || [])]) {
    if (!project?.id) continue;
    projects.set(project.id, project);
  }
  merged.projects = [...projects.values()];
  if (String(incoming.updatedAt || '') > String(merged.updatedAt || '')) merged.updatedAt = incoming.updatedAt;
  return merged;
}

/**
 * 一次提交发布多条评价：共用一次 commit，只触发一次展示站构建。
 * 已存在的评价文件会被跳过，可安全重试。
 */
export async function publishReviews({ client, config, items }) {
  const { owner, publicRepo, publicBranch, reviewsDir, companiesDir } = config;
  const treeInfo = await client.getTree(owner, publicRepo, publicBranch);
  const existingPaths = new Set(
    (treeInfo.tree || []).filter(entry => entry.type === 'blob').map(entry => entry.path),
  );

  const fresh = items.filter(({ review }) => !existingPaths.has(`${reviewsDir}/${review.companyId}/${review.id}.json`));
  if (!fresh.length) {
    return { published: [], skipped: items.map(({ review }) => review.id) };
  }

  const companyIds = [...new Set(fresh.map(({ company }) => company.id))];
  const existingCompanies = new Map();
  await Promise.all(companyIds.map(async companyId => {
    const path = `${companiesDir}/${companyId}.json`;
    if (!existingPaths.has(path)) return;
    const file = await client.getFile(owner, publicRepo, path, publicBranch);
    if (file?.content) existingCompanies.set(companyId, JSON.parse(file.content));
  }));

  const companies = new Map();
  for (const { company } of fresh) {
    const base = companies.get(company.id) || existingCompanies.get(company.id) || company;
    companies.set(company.id, mergeCompanyFiles(base, company));
  }

  const files = [
    ...fresh.map(({ review }) => ({
      path: `${reviewsDir}/${review.companyId}/${review.id}.json`,
      content: JSON.stringify(review, null, 2) + '\n',
    })),
    ...[...companies.values()].map(company => ({
      path: `${companiesDir}/${company.id}.json`,
      content: JSON.stringify(company, null, 2) + '\n',
    })),
  ];

  const blobs = await Promise.all(files.map(file => client.createBlob(owner, publicRepo, file.content)));
  const treeEntries = files.map((file, index) => ({
    path: file.path,
    mode: '100644',
    type: 'blob',
    sha: blobs[index].sha,
  }));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const ref = await client.getRef(owner, publicRepo, publicBranch);
      const base = await client.getCommit(owner, publicRepo, ref.object.sha);
      const tree = await client.createTree(owner, publicRepo, {
        base_tree: base.tree.sha,
        tree: treeEntries,
      });
      const commit = await client.createCommit(owner, publicRepo, {
        message: `data: publish ${fresh.length} review${fresh.length > 1 ? 's' : ''}`,
        tree: tree.sha,
        parents: [ref.object.sha],
      });
      await client.patchRef(owner, publicRepo, publicBranch, commit.sha);
      return {
        published: fresh.map(({ review }) => review.id),
        skipped: items.filter(item => !fresh.includes(item)).map(({ review }) => review.id),
        commitSha: commit.sha,
      };
    } catch (error) {
      if (error.status === 409 && attempt === 0) continue;
      throw error;
    }
  }

  throw new Error('发布冲突，请重试');
}

/**
 * 把审核结果原子写入公开仓。重复调用时以 reviewId 判断是否已写入，可安全重试。
 */
export async function publishReview({ client, config, review, company }) {
  const { reviewsDir, companiesDir } = config;
  const result = await publishReviews({ client, config, items: [{ review, company }] });
  return {
    reviewPath: `${reviewsDir}/${review.companyId}/${review.id}.json`,
    companyPath: `${companiesDir}/${company.id}.json`,
    published: result.published.length > 0,
    commitSha: result.commitSha,
  };
}
