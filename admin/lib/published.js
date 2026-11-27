import { autoSlug, today } from './review.js';

const clone = value => JSON.parse(JSON.stringify(value));

/**
 * 别名输入框：中英文逗号、换行都可分隔；去重并去掉空项。
 */
export function parseAliases(text) {
  const items = String(text || '')
    .split(/[,，\n]/)
    .map(item => item.trim())
    .filter(Boolean);
  return [...new Set(items)];
}

/**
 * 在已展示评价基础上生成修正后的评价对象。
 * 只改可编辑字段，保留其余未知字段；revision 自动加一。
 */
export function composeReview(original, {
  score,
  title = '',
  comment = '',
  projectId = '',
  projectAnonymous = false,
  tenure = '',
  tags = [],
  publishedAt = today(),
}) {
  const next = clone(original);
  next.score = score;
  if (title) next.title = title;
  else delete next.title;
  next.comment = comment;

  const profile = { ...(original.profile || {}) };
  if (tenure) profile.tenure = tenure;
  else delete profile.tenure;
  if (Object.keys(profile).length) next.profile = profile;
  else delete next.profile;

  if (tags.length) next.tags = [...tags];
  else delete next.tags;

  if (projectAnonymous) {
    next.projectAnonymous = true;
    delete next.projectId;
  } else if (projectId) {
    delete next.projectAnonymous;
    next.projectId = projectId;
  } else {
    delete next.projectAnonymous;
    delete next.projectId;
  }

  next.publishedAt = publishedAt;
  next.revision = Math.max(1, Number(original.revision) || 1) + 1;
  return next;
}

/** 忽略 revision 比较评价内容是否真的发生变化。 */
export function reviewContentChanged(original, next) {
  const strip = value => {
    const copy = clone(value);
    delete copy.revision;
    return JSON.stringify(copy);
  };
  return strip(original) !== strip(next);
}

/** 找出评价实际引用的项目 ID，用于阻止删除仍被引用的项目。 */
export function referencedProjectIds(reviews) {
  const ids = new Set();
  for (const review of reviews) {
    if (review?.projectId) ids.add(review.projectId);
  }
  return ids;
}

/** 生成公司文件的新内容；updatedAt 只在真正保存时更新。 */
export function composeCompany(original, { name, slug, aliases, projects }, date = today()) {
  return {
    ...clone(original),
    name,
    slug,
    aliases,
    projects,
    updatedAt: date,
  };
}

/** 忽略 updatedAt 比较公司信息是否有改动。 */
export function companyContentChanged(original, next) {
  if ((original.name || '') !== (next.name || '')) return true;
  if ((original.slug || '') !== (next.slug || '')) return true;
  if (JSON.stringify(original.aliases || []) !== JSON.stringify(next.aliases || [])) return true;
  return JSON.stringify(original.projects || []) !== JSON.stringify(next.projects || []);
}

/** 依据项目名生成不冲突的项目 ID。 */
export function newProjectId(name, existingIds = new Set()) {
  const base = `p_${autoSlug(name)}`;
  if (!existingIds.has(base)) return base;
  let index = 2;
  while (existingIds.has(`${base}-${index}`)) index += 1;
  return `${base}-${index}`;
}

// ── 数据表维护：编辑草稿快照 ─────────────────────────────────────────────

/** 把已展示评价转成表格编辑用的扁平字段。 */
export function reviewSnapshot(data) {
  return {
    score: String(Number(data.score) || 0),
    title: data.title || '',
    comment: data.comment || '',
    project: data.projectAnonymous ? '__anon' : (data.projectId || '__none'),
    publishedAt: data.publishedAt || '',
    tenure: data.profile?.tenure || '',
    tags: [...(data.tags || [])].sort(),
  };
}

/** 比较表格草稿与已保存数据是否不同（忽略 revision 与标签顺序）。 */
export function reviewSnapshotChanged(data, snapshot) {
  if (!snapshot) return false;
  const base = reviewSnapshot(data);
  return base.score !== String(snapshot.score)
    || base.title !== snapshot.title
    || base.comment !== snapshot.comment
    || base.project !== snapshot.project
    || base.publishedAt !== snapshot.publishedAt
    || base.tenure !== snapshot.tenure
    || base.tags.join('\u0000') !== [...(snapshot.tags || [])].sort().join('\u0000');
}

/** 项目的可编辑字段快照，用于表格批量维护。 */
export function projectSnapshot(projects) {
  return (projects || []).map(project => ({
    id: project.id || '',
    name: project.name || '',
    status: project.status || 'unknown',
  }));
}

/** 用固定分隔符拼接项目行，便于比较是否有改动。 */
export function projectSnapshotKey(rows) {
  return (rows || [])
    .map(row => `${row.id}\u0000${row.name}\u0000${row.status}`)
    .join('\n');
}

/** 合并项目编辑结果：保留原有扩展字段，只覆盖 id / name / status。 */
export function composeProjects(originalProjects, rows) {
  return (rows || []).map(row => {
    const base = (originalProjects || []).find(project => project.id === row.id) || {};
    return { ...clone(base), id: row.id, name: row.name, status: row.status };
  });
}
