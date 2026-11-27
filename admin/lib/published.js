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

/** 生成项目的新内容；保留 genre / featuredReviewId / hidden 等其余字段。 */
export function composeProject(original, { name, aliases = [], status }) {
  const next = { ...clone(original), name, status };
  if (aliases.length) next.aliases = [...aliases];
  else delete next.aliases;
  return next;
}
