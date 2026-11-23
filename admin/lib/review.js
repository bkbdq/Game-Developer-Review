const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const COMPANY_ID = /^c_[a-z0-9_-]+$/;
const PROJECT_ID = /^p_[a-z0-9_-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function encodeTime(value, length) {
  let time = value;
  let output = '';
  for (let index = 0; index < length; index += 1) {
    output = ALPHABET[time % 32] + output;
    time = Math.floor(time / 32);
  }
  return output;
}

export function newReviewId(now = Date.now()) {
  const random = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => ALPHABET[byte % 32]).join('');
  return `rv_${encodeTime(now, 10)}${random}`;
}

export const today = () => new Date().toISOString().slice(0, 10);

export function slugify(value) {
  return String(value || '')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 根据名称生成 slug：纯 ASCII 直接转写；含中文等字符时追加稳定短哈希，避免撞名。
 */
export function autoSlug(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const ascii = slugify(text);
  if (!/[^\x00-\x7F]/.test(text)) return ascii;
  let hash = 0x811c9dc5;
  for (const char of text) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  const suffix = (hash >>> 0).toString(36).padStart(6, '0').slice(-6);
  if (!ascii) return `n${suffix}`;
  return `${ascii.slice(0, 20).replace(/-+$/, '')}-${suffix}`;
}

export function parseJson(content, label = 'JSON') {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${label} 解析失败：${error.message}`);
  }
}

export function parseSubmission(raw) {
  if (!raw || typeof raw !== 'object' || !raw.payload || typeof raw.payload !== 'object') return null;
  const payload = raw.payload;
  return {
    submissionId: String(raw.submissionId || ''),
    submittedAt: String(raw.submittedAt || ''),
    companyId: String(payload.companyId || ''),
    company: String(payload.company || ''),
    project: String(payload.project || ''),
    score: Number(payload.score) || 0,
    comment: String(payload.comment || ''),
    wish: String(payload.wish || ''),
    // M3·FE-7「不公开项目名」：问卷后续版本会带此标记，旧提交没有则视为 false
    projectHidden: Boolean(payload.projectHidden),
    profile: payload.profile || {},
    flags: Array.isArray(raw.meta?.flags) ? raw.meta.flags : [],
    meta: raw.meta || {},
  };
}

function taxonomyKeys(taxonomy, name) {
  return new Set((taxonomy?.[name] || []).map(item => item.key));
}

export function validateDraft(draft, { taxonomy, company } = {}) {
  const errors = [];
  if (!COMPANY_ID.test(draft.companyId || '')) errors.push('公司 ID 必须形如 c_xxx');
  if (draft.projectAnonymous) {
    if (draft.projectId) errors.push('匿名项目评价不能同时关联具体项目');
  } else if (draft.projectId && !PROJECT_ID.test(draft.projectId)) errors.push('项目 ID 必须形如 p_xxx');
  if (draft.projectId && company && !company.projects.some(project => project.id === draft.projectId)) {
    errors.push('项目不属于当前公司');
  }
  if (!Number.isInteger(draft.score) || draft.score < 1 || draft.score > 5) errors.push('评分必须是 1–5 的整数');
  if (!draft.comment || draft.comment.length > 2000) errors.push('评价正文不能为空且不超过 2000 字');
  if (draft.title && draft.title.length > 40) errors.push('标题不超过 40 字');
  if (!DATE.test(draft.publishedAt || '')) errors.push('发布日期格式应为 YYYY-MM-DD');

  const roles = taxonomyKeys(taxonomy, 'roles');
  const tenures = taxonomyKeys(taxonomy, 'tenures');
  const employments = taxonomyKeys(taxonomy, 'employments');
  const cities = taxonomyKeys(taxonomy, 'cities');
  const tags = taxonomyKeys(taxonomy, 'tags');
  const profile = draft.profile || {};
  if (profile.role && !roles.has(profile.role)) errors.push('岗位不在枚举中');
  if (profile.tenure && !tenures.has(profile.tenure)) errors.push('司龄不在枚举中');
  if (profile.employment && !employments.has(profile.employment)) errors.push('在职状态不在枚举中');
  if (profile.city && !cities.has(profile.city)) errors.push('城市不在枚举中');
  (draft.tags || []).forEach(tag => {
    if (!tags.has(tag)) errors.push(`标签 ${tag} 不在枚举中`);
  });
  return errors;
}

export function validateCompany(company) {
  const errors = [];
  if (!COMPANY_ID.test(company.id || '')) errors.push('公司 ID 必须形如 c_xxx');
  if (!/^[a-z0-9-]+$/.test(company.slug || '')) errors.push('slug 只能包含小写字母、数字和连字符');
  if (!company.name || company.name.length > 50) errors.push('公司名称不能为空且不超过 50 字');
  (company.projects || []).forEach(project => {
    if (!PROJECT_ID.test(project.id || '')) errors.push(`项目 ID ${project.id} 不合法`);
    if (!project.name || project.name.length > 50) errors.push('项目名称不能为空且不超过 50 字');
    if (!['live', 'dev', 'cancelled', 'unknown'].includes(project.status)) errors.push('项目状态不合法');
  });
  return errors;
}

export function buildReview(draft) {
  return {
    schemaVersion: 1,
    id: draft.id,
    companyId: draft.companyId,
    ...(draft.projectAnonymous ? { projectAnonymous: true } : {}),
    ...(!draft.projectAnonymous && draft.projectId ? { projectId: draft.projectId } : {}),
    score: draft.score,
    ...(draft.title ? { title: draft.title } : {}),
    comment: draft.comment,
    ...(Object.keys(draft.profile || {}).length ? { profile: draft.profile } : {}),
    ...(draft.tags?.length ? { tags: draft.tags } : {}),
    publishedAt: draft.publishedAt,
    revision: 1,
  };
}

export function buildCompany({ id, slug, name, aliases = [], project = null, date = today() }) {
  return {
    schemaVersion: 1,
    id,
    slug,
    name,
    aliases,
    projects: project ? [project] : [],
    createdAt: date,
    updatedAt: date,
  };
}

export function mergeCompany(company, { project = null, date = today() } = {}) {
  const next = JSON.parse(JSON.stringify(company));
  next.updatedAt = date;
  if (project && !next.projects.some(item => item.id === project.id)) {
    next.projects.push(project);
  }
  return next;
}
