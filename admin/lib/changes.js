/**
 * 数据维护的浏览器本地待审核改动。
 * 每次修改先写入 localStorage，再到审核台确认并批量提交，避免每次修改都触发站点重建。
 */

export const STORAGE_KEY = 'gdr.admin.dataChanges';
export const CHANGES_EVENT = 'gdr-changes-updated';

const STATUS_LABELS = { live: '已上线', dev: '在研', cancelled: '已取消', unknown: '状态未知' };

const clone = value => JSON.parse(JSON.stringify(value));

function makeId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return `chg_${crypto.randomUUID()}`;
  return `chg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function comparable(value) {
  if (value === null || value === undefined) return null;
  const copy = clone(value);
  delete copy.updatedAt;
  delete copy.revision;
  return copy;
}

const same = (a, b) => JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));

export function loadChanges() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(data)
      ? data.filter(item => item && typeof item.path === 'string' && typeof item.kind === 'string')
      : [];
  } catch {
    return [];
  }
}

export function saveChanges(list) {
  if (list.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  else localStorage.removeItem(STORAGE_KEY);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGES_EVENT, { detail: { count: list.length } }));
  }
}

/**
 * 按目标文件合并改动：同一文件多次修改只保留最初 before 与最新 after。
 * 改回原样时自动移除该条记录。
 */
export function stageChange(change) {
  const list = loadChanges();
  const index = list.findIndex(item => item.path === change.path);
  const stagedAt = new Date().toISOString();

  if (index === -1) {
    if (same(change.before, change.after)) return list;
    list.push({ ...change, id: makeId(), stagedAt });
  } else {
    const existing = list[index];
    const next = {
      ...existing,
      ...change,
      id: existing.id,
      before: existing.before,
      stagedAt,
    };
    if (same(next.before, next.after)) list.splice(index, 1);
    else list[index] = next;
  }

  saveChanges(list);
  return list;
}

export function discardChange(id) {
  const list = loadChanges().filter(item => item.id !== id);
  saveChanges(list);
  return list;
}

export function clearChanges() {
  saveChanges([]);
}

/** 依据改动列表算出需要标「待审核」的评价、公司和项目。 */
export function collectPendingIds(changes) {
  const reviewIds = new Set();
  const companyIds = new Set();
  const projectKeys = new Set();

  changes.forEach(change => {
    if (change.kind === 'review') {
      if (change.reviewId) reviewIds.add(change.reviewId);
      return;
    }
    if (!change.companyId) return;
    companyIds.add(change.companyId);

    const before = new Map(((change.before?.projects) || []).map(project => [project.id, project]));
    const after = new Map(((change.after?.projects) || []).map(project => [project.id, project]));
    const ids = new Set([...before.keys(), ...after.keys()]);
    ids.forEach(id => {
      if (JSON.stringify(before.get(id) ?? null) !== JSON.stringify(after.get(id) ?? null)) {
        projectKeys.add(`${change.companyId}:${id}`);
      }
    });
  });

  return { reviewIds, companyIds, projectKeys };
}

/** 把待审核改动叠加到已加载的数据上，返回供标红使用的 ID 集合。 */
export function applyChangesToData(changes, { companies, reviews }) {
  const pending = collectPendingIds(changes);
  changes.forEach(change => {
    if (change.kind === 'review') {
      if (!change.reviewId) return;
      if (change.after === null) reviews.delete(change.reviewId);
      else if (reviews.has(change.reviewId)) reviews.get(change.reviewId).data = change.after;
      else reviews.set(change.reviewId, { path: change.path, sha: '', data: change.after });
      return;
    }
    if (!change.companyId) return;
    if (change.after === null) companies.delete(change.companyId);
    else if (companies.has(change.companyId)) companies.get(change.companyId).data = change.after;
    else companies.set(change.companyId, { path: change.path, sha: '', data: change.after });
  });
  return pending;
}

// ── 差异描述 ──────────────────────────────────────────────────────────────

const formatValue = (value) => {
  if (value === undefined || value === null || value === '') return '—';
  if (Array.isArray(value)) return value.length ? value.join('、') : '—';
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
};

function reviewView(data, labels = {}) {
  if (!data) return null;
  const project = data.projectAnonymous
    ? '匿名项目'
    : (data.projectId ? (labels.projects?.[data.projectId] || data.projectId) : '未关联');
  return {
    score: data.score,
    title: data.title || '',
    comment: data.comment || '',
    project,
    tags: data.tags || [],
    publishedAt: data.publishedAt || '',
    tenure: data.profile?.tenure || '',
    hidden: Boolean(data.hidden),
  };
}

function companyView(data) {
  if (!data) return null;
  return {
    name: data.name || '',
    slug: data.slug || '',
    aliases: data.aliases || [],
    hidden: Boolean(data.hidden),
  };
}

function projectView(project) {
  return {
    name: project.name || '',
    status: STATUS_LABELS[project.status] || project.status || '—',
    aliases: project.aliases || [],
    hidden: Boolean(project.hidden),
  };
}

const REVIEW_FIELDS = [
  ['score', '评分'],
  ['title', '标题'],
  ['comment', '正文'],
  ['project', '项目'],
  ['tags', '标签'],
  ['publishedAt', '发布日期'],
  ['tenure', '在职时长'],
  ['hidden', '隐藏'],
];

const COMPANY_FIELDS = [
  ['name', '公司名'],
  ['slug', 'slug'],
  ['aliases', '别名'],
  ['hidden', '隐藏'],
];

const PROJECT_FIELDS = [
  ['name', '项目名'],
  ['status', '状态'],
  ['aliases', '别名'],
  ['hidden', '隐藏'],
];

function buildRows(fields, before, after, { changedOnly = true } = {}) {
  return fields.map(([key, label]) => {
    const from = formatValue(before?.[key]);
    const to = formatValue(after?.[key]);
    return { label, from, to, changed: from !== to };
  }).filter(row => !changedOnly || row.changed);
}

function actionOf(change, changedKeys) {
  if (change.after === null) return '删除';
  if (change.before === null) return '新增';
  if (changedKeys.length === 1 && changedKeys[0] === 'hidden') {
    return change.after.hidden ? '隐藏' : '显示';
  }
  return '修改';
}

function describeReview(change) {
  const labels = change.labels || {};
  const before = reviewView(change.before, labels);
  const after = reviewView(change.after, labels);
  const deleted = change.after === null;
  const rows = buildRows(REVIEW_FIELDS, before, after, { changedOnly: !deleted });
  const changedKeys = rows.map(row => REVIEW_FIELDS.find(([, label]) => label === row.label)?.[0]).filter(Boolean);
  return {
    action: actionOf(change, changedKeys),
    rows,
    projects: [],
    deleted,
  };
}

function projectDiffs(beforeCompany, afterCompany) {
  const before = new Map(((beforeCompany?.projects) || []).map(project => [project.id, project]));
  const after = new Map(((afterCompany?.projects) || []).map(project => [project.id, project]));
  const ids = [...new Set([...before.keys(), ...after.keys()])];
  return ids.map(id => {
    const oldProject = before.get(id);
    const newProject = after.get(id);
    if (!oldProject) {
      return {
        kind: 'added',
        name: newProject.name || id,
        rows: buildRows(PROJECT_FIELDS, null, projectView(newProject), { changedOnly: false }),
      };
    }
    if (!newProject) {
      return {
        kind: 'removed',
        name: oldProject.name || id,
        rows: buildRows(PROJECT_FIELDS, projectView(oldProject), null, { changedOnly: false }),
      };
    }
    const rows = buildRows(PROJECT_FIELDS, projectView(oldProject), projectView(newProject));
    return rows.length ? { kind: 'changed', name: newProject.name || id, rows } : null;
  }).filter(Boolean);
}

function describeCompany(change) {
  const before = companyView(change.before);
  const after = companyView(change.after);
  const deleted = change.after === null;
  const rows = buildRows(COMPANY_FIELDS, before, after, { changedOnly: !deleted });
  const changedKeys = rows.map(row => COMPANY_FIELDS.find(([, label]) => label === row.label)?.[0]).filter(Boolean);
  return {
    action: actionOf(change, changedKeys),
    rows,
    projects: projectDiffs(change.before, change.after),
    deleted,
  };
}

export function describeChange(change) {
  return change.kind === 'review' ? describeReview(change) : describeCompany(change);
}
