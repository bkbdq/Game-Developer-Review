import { createClient } from './lib/github.js';
import { createApi } from './lib/api.js';
import { getToken, setToken, clearToken } from './lib/token.js';
import { config } from './config.js';
import { h } from './lib/dom.js';
import { scanDraft } from './lib/sensitive.js';
import { parseJson, today, validateDraft, validateCompany } from './lib/review.js';
import {
  parseAliases,
  composeReview,
  reviewContentChanged,
  referencedProjectIds,
  composeCompany,
  companyContentChanged,
  newProjectId,
} from './lib/published.js';

const PROJECT_STATUSES = [
  ['live', '已上线'],
  ['dev', '在研'],
  ['cancelled', '已取消'],
  ['unknown', '状态未知'],
];

const $ = selector => document.querySelector(selector);
const bootView = $('#boot-view');
const bootStatus = $('#boot-status');
const bootActions = $('#boot-actions');
const bootRetry = $('#boot-retry');
const bootLogin = $('#boot-login');
const loginView = $('#login-view');
const loginForm = $('#login-form');
const tokenInput = $('#token');
const loginStatus = $('#login-status');
const appView = $('#app-view');
const logoutButton = $('#logout-button');
const userLabel = $('#user-label');
const filterInput = $('#filter');
const refreshButton = $('#refresh-button');
const companyCount = $('#company-count');
const companyList = $('#company-list');
const detailEmpty = $('#detail-empty');
const companyDetail = $('#company-detail');
const companyNameLabel = $('#company-name-label');
const companyMeta = $('#company-meta');
const companyBadge = $('#company-badge');
const companyForm = $('#company-form');
const companyNameInput = $('#company-field-name');
const companySlugInput = $('#company-field-slug');
const companyAliasesInput = $('#company-field-aliases');
const projectRows = $('#project-rows');
const addProjectButton = $('#add-project-button');
const resetCompanyButton = $('#reset-company-button');
const companyStatus = $('#company-status');
const reviewCountLabel = $('#review-count');
const reloadReviewsButton = $('#reload-reviews-button');
const reviewList = $('#review-list');
const reviewForm = $('#review-form');
const reviewIdLabel = $('#review-id-label');
const reviewScore = $('#review-score');
const reviewProject = $('#review-project');
const reviewDate = $('#review-published-at');
const reviewTitle = $('#review-title');
const reviewComment = $('#review-comment');
const reviewTenure = $('#review-tenure');
const reviewTags = $('#review-tags');
const reviewSensitive = $('#review-sensitive');
const reviewStatus = $('#review-status');
const deleteReviewButton = $('#delete-review-button');
const cancelReviewButton = $('#cancel-review-button');
const closeReviewButton = $('#close-review-button');
const globalStatus = $('#global-status');

const state = {
  client: null,
  api: null,
  taxonomy: null,
  companies: new Map(),
  reviewPaths: new Map(),
  reviews: new Map(),
  selectedId: null,
  editingId: null,
  companyDirty: false,
  reviewDirty: false,
  busy: false,
};

function setStatus(element, message, isError = false) {
  element.textContent = message || '';
  element.classList.toggle('error', Boolean(isError));
}

function showBoot(message, { error = false } = {}) {
  bootView.hidden = false;
  bootActions.hidden = !error;
  loginView.hidden = true;
  appView.hidden = true;
  logoutButton.hidden = true;
  setStatus(bootStatus, message || '正在验证登录状态…', error);
}

function showLogin(message = '') {
  bootView.hidden = true;
  loginView.hidden = false;
  appView.hidden = true;
  logoutButton.hidden = true;
  setStatus(loginStatus, message, Boolean(message));
}

function showApp() {
  bootView.hidden = true;
  loginView.hidden = true;
  appView.hidden = false;
  logoutButton.hidden = false;
}

function describeError(error) {
  if (error instanceof TypeError) return '无法连接服务，请确认网络能访问 GitHub API（必要时开启代理后重试）。';
  if (error.status === 401) return 'token 已失效，请重新登录。';
  if (error.status === 403) return error.message || '没有仓库写权限。';
  if (error.status === 404) return '文件不存在，可能已被其他人删除，请刷新后重试。';
  if (error.status === 409) return '文件已被其他人修改，请刷新后重新编辑。';
  return error.message || '操作失败';
}

function clip(text, max = 80) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  return source.length > max ? `${source.slice(0, max)}…` : source;
}

function currentCompany() {
  return state.selectedId ? state.companies.get(state.selectedId) || null : null;
}

function currentReviews() {
  return state.selectedId ? state.reviews.get(state.selectedId) || new Map() : new Map();
}

function confirmDiscard() {
  if (state.companyDirty && !window.confirm('公司信息有未保存的修改，确定放弃？')) return false;
  if (state.reviewDirty && !window.confirm('评价有未保存的修改，确定放弃？')) return false;
  return true;
}

function handleError(error) {
  if (error.status === 401) {
    signOut('登录已失效，请重新登录。');
    return;
  }
  setStatus(globalStatus, describeError(error), true);
}

function handleSaveError(error, element) {
  if (error.status === 401) {
    signOut('登录已失效，请重新登录。');
    return;
  }
  setStatus(element, describeError(error), true);
}

async function logAudit(action, payload) {
  try {
    await state.api.logEvent({ action, ...payload });
  } catch {
    // 审计写入失败不影响保存结果
  }
}

// ── 基础渲染 ──────────────────────────────────────────────────────────────

function renderTaxonomy() {
  reviewTenure.replaceChildren(
    h('option', { value: '' }, '不填'),
    ...(state.taxonomy.tenures || []).map(entry => h('option', { value: entry.key }, entry.label)),
  );
  reviewTags.replaceChildren(
    ...(state.taxonomy.tags || []).map(tag =>
      h('label', {}, h('input', { type: 'checkbox', value: tag.key }), tag.label)),
  );
}

function companyMatches(entry, query) {
  if (!query) return true;
  const data = entry.data;
  const haystack = [
    data.name,
    data.id,
    data.slug,
    ...(data.aliases || []),
    ...(data.projects || []).map(project => project.name),
  ].join(' ').toLowerCase();
  return haystack.includes(query);
}

function renderCompanyList() {
  const query = filterInput.value.trim().toLowerCase();
  const entries = [...state.companies.values()]
    .filter(entry => companyMatches(entry, query))
    .sort((a, b) => a.data.name.localeCompare(b.data.name, 'zh-CN'));

  companyList.replaceChildren();
  if (!entries.length) {
    companyList.append(h('p', { class: 'empty' }, query ? '没有匹配项' : '暂无已展示数据'));
  }
  entries.forEach(entry => {
    const count = (state.reviewPaths.get(entry.data.id) || []).length;
    companyList.append(h('button', {
      type: 'button',
      class: 'item' + (state.selectedId === entry.data.id ? ' active' : ''),
      onClick: () => selectCompany(entry.data.id),
    },
      h('div', { class: 'item-head' },
        h('strong', {}, entry.data.name),
        h('span', {}, `${count} 条`)),
      h('div', { class: 'item-meta' },
        `${entry.data.projects?.length || 0} 个项目 · ${entry.data.slug}`),
    ));
  });

  companyCount.textContent = query
    ? `匹配 ${entries.length} / 共 ${state.companies.size} 家`
    : `共 ${state.companies.size} 家公司`;
}

function renderCompanyHead() {
  const entry = currentCompany();
  if (!entry) return;
  const count = (state.reviewPaths.get(entry.data.id) || []).length;
  companyNameLabel.textContent = entry.data.name;
  companyBadge.textContent = entry.data.id;
  companyMeta.textContent = `最近更新 ${entry.data.updatedAt || '—'} · ${entry.data.projects?.length || 0} 个项目 · ${count} 条已展示评价`;
}

function currentProjectIds() {
  return new Set(
    [...projectRows.querySelectorAll('.project-id-input')]
      .map(input => input.value.trim())
      .filter(Boolean),
  );
}

function buildProjectRow(project, referenced) {
  const existing = Boolean(project);
  const idInput = h('input', {
    class: 'project-id-input',
    value: project?.id || '',
    placeholder: 'p_xxx',
    autocomplete: 'off',
    spellcheck: false,
  });
  if (existing) {
    idInput.readOnly = true;
    idInput.dataset.touched = '1';
  }
  const nameInput = h('input', {
    class: 'project-name-input',
    value: project?.name || '',
    placeholder: '项目名',
    maxLength: 50,
    autocomplete: 'off',
  });
  const statusSelect = h('select', { class: 'project-status-select' },
    ...PROJECT_STATUSES.map(([value, label]) => h('option', { value }, label)));
  statusSelect.value = project?.status || 'unknown';

  const removeButton = h('button', {
    type: 'button',
    class: 'ghost small',
    onClick: () => {
      if (existing && referenced.has(project.id)) return;
      state.companyDirty = true;
      row.remove();
    },
  }, '移除');
  if (existing && referenced.has(project.id)) {
    removeButton.disabled = true;
    removeButton.title = '该项目下已有展示评价，不能删除';
  }

  const row = h('div', { class: 'project-row', dataset: { id: project?.id || '' } },
    h('label', {}, '项目 ID', idInput),
    h('label', {}, '项目名', nameInput),
    h('label', {}, '状态', statusSelect),
    removeButton,
  );

  nameInput.addEventListener('input', () => {
    if (existing || idInput.dataset.touched === '1') return;
    const name = nameInput.value.trim();
    const others = currentProjectIds();
    others.delete(idInput.value.trim());
    idInput.value = name ? newProjectId(name, others) : '';
  });
  idInput.addEventListener('input', () => { idInput.dataset.touched = '1'; });

  return row;
}

function renderProjectRows(projects) {
  const referenced = referencedProjectIds([...currentReviews().values()].map(entry => entry.data));
  projectRows.replaceChildren();
  if (!projects.length) {
    projectRows.append(h('p', { class: 'empty' }, '暂无项目，可点右上角添加'));
    return;
  }
  projects.forEach(project => projectRows.append(buildProjectRow(project, referenced)));
}

function addProjectRow() {
  projectRows.querySelector('.empty')?.remove();
  const row = buildProjectRow(null, new Set());
  projectRows.append(row);
  state.companyDirty = true;
  row.querySelector('.project-name-input').focus();
}

function fillCompanyForm() {
  const entry = currentCompany();
  if (!entry) return;
  companyNameInput.value = entry.data.name || '';
  companySlugInput.value = entry.data.slug || '';
  companyAliasesInput.value = (entry.data.aliases || []).join('，');
  renderProjectRows(entry.data.projects || []);
  state.companyDirty = false;
}

function fillReviewProjectOptions(company, review) {
  const known = new Set((company.projects || []).map(project => project.id));
  const options = [
    h('option', { value: '__none' }, '不关联项目'),
    ...(company.projects || []).map(project => h('option', { value: project.id }, project.name)),
  ];
  if (review.projectId && !known.has(review.projectId)) {
    options.push(h('option', { value: review.projectId }, `未知项目 ${review.projectId}`));
  }
  options.push(h('option', { value: '__anon' }, '匿名项目'));
  reviewProject.replaceChildren(...options);
  reviewProject.value = review.projectAnonymous ? '__anon' : (review.projectId || '__none');
}

// ── 评价列表与编辑 ────────────────────────────────────────────────────────

function renderReviews() {
  const company = currentCompany();
  if (!company) return;
  const reviews = [...currentReviews().values()]
    .sort((a, b) => (b.data.publishedAt || '').localeCompare(a.data.publishedAt || '')
      || b.data.id.localeCompare(a.data.id));
  reviewCountLabel.textContent = String(reviews.length);
  reviewList.replaceChildren();
  if (!reviews.length) {
    reviewList.append(h('p', { class: 'empty' }, '该公司还没有已展示评价'));
    return;
  }
  reviews.forEach(({ data }) => {
    const project = data.projectAnonymous
      ? '匿名项目'
      : ((company.data.projects || []).find(item => item.id === data.projectId)?.name || '未关联项目');
    const revision = Number(data.revision) || 1;
    reviewList.append(h('div', {
      class: 'review-item' + (state.editingId === data.id ? ' active' : ''),
    },
      h('div', { class: 'review-item-head' },
        h('strong', {}, `${data.score} 星 · ${project}`),
        h('span', { class: 'review-item-meta' },
          `${data.publishedAt || '—'}${revision > 1 ? ` · 已更正 v${revision}` : ''}`)),
      h('p', { class: 'review-item-text' },
        data.title ? `${data.title}｜${clip(data.comment, 70)}` : clip(data.comment, 80)),
      h('div', { class: 'actions' },
        h('button', {
          type: 'button',
          class: 'ghost small',
          onClick: () => openReview(data.id),
        }, '编辑')),
    ));
  });
}

function openReview(reviewId) {
  const company = currentCompany();
  const entry = currentReviews().get(reviewId);
  if (!company || !entry) return;
  if (state.reviewDirty && !window.confirm('当前评价有未保存的修改，确定放弃？')) return;

  const data = entry.data;
  state.editingId = reviewId;
  reviewIdLabel.textContent = `${data.id} · v${Number(data.revision) || 1}`;
  reviewScore.value = String(data.score || 3);
  fillReviewProjectOptions(company.data, data);
  reviewDate.value = data.publishedAt || today();
  reviewTitle.value = data.title || '';
  reviewComment.value = data.comment || '';
  reviewTenure.value = data.profile?.tenure || '';
  reviewTags.querySelectorAll('input').forEach(input => {
    input.checked = (data.tags || []).includes(input.value);
  });
  reviewForm.hidden = false;
  state.reviewDirty = false;
  setStatus(reviewStatus, '');
  refreshReviewSensitive();
  renderReviews();
  reviewForm.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function closeReviewEditor({ force = false } = {}) {
  if (!force && state.reviewDirty && !window.confirm('评价有未保存的修改，确定放弃？')) return;
  state.editingId = null;
  state.reviewDirty = false;
  reviewForm.hidden = true;
  setStatus(reviewStatus, '');
  renderReviews();
}

function reviewSensitiveResult() {
  return scanDraft({ comment: reviewComment.value, title: reviewTitle.value });
}

function refreshReviewSensitive() {
  const result = reviewSensitiveResult();
  const hard = result.hits.filter(hit => hit.level === 'hard');
  const soft = result.hits.filter(hit => hit.level === 'soft');
  const parts = [];
  if (hard.length) {
    parts.push(`禁止保存：${hard.map(hit => `${hit.field}有${hit.type}「${clip(hit.fragment, 20)}」`).join('、')}`);
  }
  if (soft.length) {
    parts.push(`提醒：${soft.map(hit => `${hit.field}疑似${hit.type}「${clip(hit.fragment, 20)}」`).join('、')}`);
  }
  setStatus(reviewSensitive, parts.join('；'));
  reviewSensitive.classList.toggle('blocked', hard.length > 0);
  reviewSensitive.classList.toggle('warn', !hard.length && soft.length > 0);
}

async function saveReview(event) {
  event.preventDefault();
  if (state.busy) return;
  const company = currentCompany();
  const entry = state.editingId ? currentReviews().get(state.editingId) : null;
  if (!company || !entry) return;

  const original = entry.data;
  const score = Number(reviewScore.value);
  const projectChoice = reviewProject.value;
  const projectAnonymous = projectChoice === '__anon';
  const projectId = projectChoice === '__none' || projectAnonymous ? '' : projectChoice;
  const tenure = reviewTenure.value;
  const tags = [...reviewTags.querySelectorAll('input:checked')].map(input => input.value);
  const fields = {
    score,
    title: reviewTitle.value.trim(),
    comment: reviewComment.value.trim(),
    projectId,
    projectAnonymous,
    tenure,
    tags,
    publishedAt: reviewDate.value,
  };

  const errors = validateDraft({
    companyId: company.data.id,
    projectId,
    projectAnonymous,
    score,
    title: fields.title,
    comment: fields.comment,
    profile: tenure ? { tenure } : {},
    tags,
    publishedAt: fields.publishedAt,
  }, { taxonomy: state.taxonomy, company: company.data });
  if (reviewSensitiveResult().hits.some(hit => hit.level === 'hard')) {
    errors.push('正文或标题仍含手机号 / 邮箱 / 身份证号，请脱敏后再保存');
  }
  if (errors.length) {
    setStatus(reviewStatus, errors.join('；'), true);
    return;
  }

  const next = composeReview(original, fields);
  if (!reviewContentChanged(original, next)) {
    setStatus(reviewStatus, '没有改动');
    return;
  }

  state.busy = true;
  setStatus(reviewStatus, '正在保存…');
  try {
    const saved = await state.client.putFile(config.owner, config.publicRepo, entry.path, {
      message: `data: edit ${original.id}`,
      content: JSON.stringify(next, null, 2) + '\n',
      sha: entry.sha,
      branch: config.publicBranch,
    });
    entry.data = next;
    entry.sha = saved?.content?.sha || entry.sha;
    state.reviewDirty = false;
    reviewIdLabel.textContent = `${next.id} · v${next.revision}`;
    renderReviews();
    setStatus(reviewStatus, '已保存；展示站会自动重建（约 1–2 分钟）');
    await logAudit('published_edit', {
      targetType: 'review',
      targetId: original.id,
      reviewId: original.id,
      companyId: company.data.id,
      note: '修正已展示评价',
      commitSha: saved?.commit?.sha || '',
    });
  } catch (error) {
    handleSaveError(error, reviewStatus);
  } finally {
    state.busy = false;
  }
}

async function deleteReview() {
  if (state.busy) return;
  const company = currentCompany();
  const entry = state.editingId ? currentReviews().get(state.editingId) : null;
  if (!company || !entry) return;
  const review = entry.data;
  if (!window.confirm(`确认删除评价 ${review.id}？展示站会在下一次构建后移除。`)) return;

  state.busy = true;
  setStatus(reviewStatus, '正在删除…');
  try {
    await state.client.deleteFile(config.owner, config.publicRepo, entry.path, {
      message: `data: delete ${review.id}`,
      sha: entry.sha,
      branch: config.publicBranch,
    });
    currentReviews().delete(review.id);
    const paths = state.reviewPaths.get(company.data.id) || [];
    state.reviewPaths.set(company.data.id, paths.filter(path => path !== entry.path));
    closeReviewEditor({ force: true });
    renderCompanyList();
    renderCompanyHead();
    renderReviews();
    setStatus(companyStatus, `已删除 ${review.id}；展示站会自动重建（约 1–2 分钟）`);
    await logAudit('published_delete', {
      targetType: 'review',
      targetId: review.id,
      reviewId: review.id,
      companyId: company.data.id,
      note: '删除已展示评价',
    });
  } catch (error) {
    handleSaveError(error, reviewStatus);
  } finally {
    state.busy = false;
  }
}

// ── 公司信息编辑 ──────────────────────────────────────────────────────────

function collectProjects() {
  const company = currentCompany();
  return [...projectRows.querySelectorAll('.project-row')].map(row => {
    const base = (company.data.projects || []).find(project => project.id === row.dataset.id) || {};
    return {
      ...base,
      id: row.querySelector('.project-id-input').value.trim(),
      name: row.querySelector('.project-name-input').value.trim(),
      status: row.querySelector('.project-status-select').value,
    };
  });
}

function projectRemovalErrors(original, next) {
  const used = referencedProjectIds([...currentReviews().values()].map(entry => entry.data));
  return (original.projects || [])
    .filter(project => !next.projects.some(item => item.id === project.id))
    .filter(project => used.has(project.id))
    .map(project => `项目「${project.name}」下已有展示评价，不能删除`);
}

async function saveCompany(event) {
  event.preventDefault();
  if (state.busy) return;
  const entry = currentCompany();
  if (!entry) return;
  if (!state.reviews.has(entry.data.id)) {
    setStatus(companyStatus, '评价尚未加载完成，请点「重新加载评价」后再保存', true);
    return;
  }

  const original = entry.data;
  const next = composeCompany(original, {
    name: companyNameInput.value.trim(),
    slug: companySlugInput.value.trim(),
    aliases: parseAliases(companyAliasesInput.value),
    projects: collectProjects(),
  });

  const errors = validateCompany(next);
  const seen = new Set();
  next.projects.forEach(project => {
    if (seen.has(project.id)) errors.push(`项目 ID 重复：${project.id}`);
    seen.add(project.id);
  });
  errors.push(...projectRemovalErrors(original, next));
  if (errors.length) {
    setStatus(companyStatus, errors.join('；'), true);
    return;
  }
  if (!companyContentChanged(original, next)) {
    setStatus(companyStatus, '没有改动');
    return;
  }

  state.busy = true;
  setStatus(companyStatus, '正在保存公司信息…');
  try {
    const saved = await state.client.putFile(config.owner, config.publicRepo, entry.path, {
      message: `data: edit company ${original.id}`,
      content: JSON.stringify(next, null, 2) + '\n',
      sha: entry.sha,
      branch: config.publicBranch,
    });
    entry.data = next;
    entry.sha = saved?.content?.sha || entry.sha;
    state.companyDirty = false;
    companyNameInput.value = next.name;
    companySlugInput.value = next.slug;
    companyAliasesInput.value = (next.aliases || []).join('，');
    renderProjectRows(next.projects);
    renderCompanyHead();
    renderCompanyList();
    renderReviews();
    setStatus(companyStatus, '已保存；展示站会自动重建（约 1–2 分钟）');
    await logAudit('published_edit', {
      targetType: 'company',
      targetId: original.id,
      companyId: original.id,
      note: '修改公司信息',
      commitSha: saved?.commit?.sha || '',
    });
  } catch (error) {
    handleSaveError(error, companyStatus);
  } finally {
    state.busy = false;
  }
}

function resetCompanyForm() {
  if (state.companyDirty && !window.confirm('公司信息有未保存的修改，确定还原？')) return;
  fillCompanyForm();
  setStatus(companyStatus, '');
}

// ── 数据加载 ──────────────────────────────────────────────────────────────

async function ensureReviews(companyId) {
  if (state.reviews.has(companyId)) return state.reviews.get(companyId);
  const paths = state.reviewPaths.get(companyId) || [];
  const files = await Promise.all(paths.map(async path => {
    try {
      return await state.client.getFile(config.owner, config.publicRepo, path, config.publicBranch);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }));
  const loaded = new Map();
  files.filter(Boolean).forEach(file => {
    const data = parseJson(file.content, file.path);
    loaded.set(data.id, { path: file.path, sha: file.sha, data });
  });
  state.reviews.set(companyId, loaded);
  return loaded;
}

async function loadData() {
  setStatus(globalStatus, '正在读取公开仓数据…');
  const [taxonomyFile, tree] = await Promise.all([
    state.client.getFile(config.owner, config.publicRepo, config.taxonomyPath, config.publicBranch),
    state.client.getTree(config.owner, config.publicRepo, config.publicBranch),
  ]);
  if (!taxonomyFile) throw new Error('公开仓缺少 taxonomy.json');

  state.taxonomy = parseJson(taxonomyFile.content, config.taxonomyPath);
  renderTaxonomy();

  const companyPaths = (tree.tree || [])
    .filter(item => item.type === 'blob'
      && item.path.startsWith(`${config.companiesDir}/`)
      && item.path.endsWith('.json'))
    .map(item => item.path);
  const files = await Promise.all(companyPaths.map(async path => {
    const file = await state.client.getFile(config.owner, config.publicRepo, path, config.publicBranch);
    if (!file) return null;
    return { path: file.path, sha: file.sha, data: parseJson(file.content, file.path) };
  }));
  state.companies = new Map(files.filter(Boolean).map(entry => [entry.data.id, entry]));

  const reviewPaths = new Map();
  (tree.tree || []).forEach(item => {
    if (item.type !== 'blob'
      || !item.path.startsWith(`${config.reviewsDir}/`)
      || !item.path.endsWith('.json')) return;
    const companyId = item.path.split('/')[2];
    if (!companyId) return;
    if (!reviewPaths.has(companyId)) reviewPaths.set(companyId, []);
    reviewPaths.get(companyId).push(item.path);
  });
  state.reviewPaths = reviewPaths;
  state.reviews = new Map();

  state.selectedId = null;
  state.editingId = null;
  state.companyDirty = false;
  state.reviewDirty = false;
  reviewForm.hidden = true;
  companyDetail.hidden = true;
  detailEmpty.hidden = false;
  setStatus(companyStatus, '');
  setStatus(reviewStatus, '');
  renderCompanyList();
}

async function selectCompany(companyId) {
  if (state.busy || companyId === state.selectedId) return;
  if (!confirmDiscard()) return;

  state.busy = true;
  state.selectedId = companyId;
  state.editingId = null;
  state.companyDirty = false;
  state.reviewDirty = false;
  reviewForm.hidden = true;
  setStatus(companyStatus, '');
  setStatus(reviewStatus, '');
  renderCompanyList();

  detailEmpty.hidden = true;
  companyDetail.hidden = false;
  renderCompanyHead();
  companyNameInput.value = '';
  companySlugInput.value = '';
  companyAliasesInput.value = '';
  projectRows.replaceChildren(h('p', { class: 'empty' }, '正在加载…'));
  reviewList.replaceChildren();

  try {
    if (!state.reviews.has(companyId)) {
      const entry = currentCompany();
      reviewList.append(h('p', { class: 'empty' }, '正在加载评价…'));
      setStatus(globalStatus, `正在加载「${entry.data.name}」的已展示评价…`);
      await ensureReviews(companyId);
      setStatus(globalStatus, '');
    }
    fillCompanyForm();
    renderReviews();
  } catch (error) {
    handleError(error);
  } finally {
    state.busy = false;
  }
}

async function reloadReviews() {
  if (state.busy || !state.selectedId) return;
  if (!confirmDiscard()) return;
  const companyId = state.selectedId;
  state.busy = true;
  state.editingId = null;
  state.reviewDirty = false;
  reviewForm.hidden = true;
  setStatus(companyStatus, '正在重新加载评价…');
  try {
    state.reviews.delete(companyId);
    await ensureReviews(companyId);
    fillCompanyForm();
    renderCompanyHead();
    renderReviews();
    setStatus(companyStatus, '已重新加载');
  } catch (error) {
    handleSaveError(error, companyStatus);
  } finally {
    state.busy = false;
  }
}

// ── 登录与事件 ────────────────────────────────────────────────────────────

async function signIn(token, { silent = false } = {}) {
  if (!token) {
    showLogin();
    return;
  }
  showBoot(silent ? '正在验证登录状态，无需重新输入 token…' : '正在登录…');
  let authenticated = false;
  try {
    const client = createClient(token);
    const api = createApi(token);
    const me = await api.me();
    authenticated = true;

    setToken(token);
    state.client = client;
    state.api = api;
    userLabel.textContent = `@${me.login}`;
    showBoot('登录有效，正在读取已展示数据…');
    await loadData();
    showApp();
    setStatus(loginStatus, '');
    setStatus(globalStatus, `已加载 ${state.companies.size} 家公司；修改保存后展示站会自动重建`);
  } catch (error) {
    state.client = null;
    state.api = null;
    if (error.status === 401) {
      clearToken();
      showLogin(describeError(error));
      return;
    }
    if (!silent && !authenticated) {
      showLogin(describeError(error));
      return;
    }
    showBoot(describeError(error), { error: true });
  }
}

function signOut(message = '') {
  clearToken();
  state.client = null;
  state.api = null;
  state.companies = new Map();
  state.reviewPaths = new Map();
  state.reviews = new Map();
  state.selectedId = null;
  state.editingId = null;
  state.companyDirty = false;
  state.reviewDirty = false;
  userLabel.textContent = '';
  companyList.replaceChildren();
  companyCount.textContent = '';
  companyDetail.hidden = true;
  detailEmpty.hidden = false;
  reviewForm.hidden = true;
  projectRows.replaceChildren();
  reviewList.replaceChildren();
  showLogin(message);
  setStatus(globalStatus, '');
}

loginForm.addEventListener('submit', event => {
  event.preventDefault();
  signIn(tokenInput.value.trim());
});
logoutButton.addEventListener('click', () => signOut());
bootRetry.addEventListener('click', () => {
  const token = getToken();
  if (token) signIn(token, { silent: true });
  else showLogin();
});
bootLogin.addEventListener('click', () => {
  clearToken();
  showLogin();
  tokenInput.focus();
});
filterInput.addEventListener('input', renderCompanyList);
refreshButton.addEventListener('click', async () => {
  if (state.busy || !state.client) return;
  if (!confirmDiscard()) return;
  refreshButton.disabled = true;
  state.busy = true;
  try {
    await loadData();
    setStatus(globalStatus, `已刷新，共 ${state.companies.size} 家公司`);
  } catch (error) {
    handleError(error);
  } finally {
    state.busy = false;
    refreshButton.disabled = false;
  }
});
addProjectButton.addEventListener('click', addProjectRow);
resetCompanyButton.addEventListener('click', resetCompanyForm);
reloadReviewsButton.addEventListener('click', reloadReviews);
companyForm.addEventListener('submit', saveCompany);
companyForm.addEventListener('input', () => { state.companyDirty = true; });
companyForm.addEventListener('change', () => { state.companyDirty = true; });
reviewForm.addEventListener('submit', saveReview);
reviewForm.addEventListener('input', () => { state.reviewDirty = true; });
reviewForm.addEventListener('change', () => { state.reviewDirty = true; });
reviewComment.addEventListener('input', refreshReviewSensitive);
reviewTitle.addEventListener('input', refreshReviewSensitive);
deleteReviewButton.addEventListener('click', deleteReview);
cancelReviewButton.addEventListener('click', () => closeReviewEditor());
closeReviewButton.addEventListener('click', () => closeReviewEditor());

window.addEventListener('beforeunload', event => {
  if (!state.companyDirty && !state.reviewDirty) return;
  event.preventDefault();
  event.returnValue = '';
});

const savedToken = getToken();
if (savedToken) signIn(savedToken, { silent: true });
else showLogin();
