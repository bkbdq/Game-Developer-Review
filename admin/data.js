import { createClient } from './lib/github.js';
import { createApi } from './lib/api.js';
import { getToken, setToken, clearToken } from './lib/token.js';
import { getSession, setSession, clearSession } from './lib/session.js';
import { config } from './config.js';
import { h } from './lib/dom.js';
import { scanDraft } from './lib/sensitive.js';
import { parseJson, validateDraft, validateCompany } from './lib/review.js';
import {
  parseAliases,
  composeReview,
  reviewContentChanged,
  composeCompany,
  companyContentChanged,
  composeProject,
  newProjectId,
} from './lib/published.js';
import {
  loadChanges,
  stageChange,
  applyChangesToData,
  collectPendingIds,
  STORAGE_KEY,
} from './lib/changes.js';

const PROJECT_STATUSES = [
  ['live', '已上线'],
  ['dev', '在研'],
  ['cancelled', '已取消'],
  ['unknown', '状态未知'],
];

const PROJECT_STATUS_LABEL = Object.fromEntries(PROJECT_STATUSES);
const VIEWS = ['reviews', 'companies', 'projects'];

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
const pendingChangesLink = $('#pending-changes-link');
const tabs = [...document.querySelectorAll('.data-tabs .tab')];
const viewReviews = $('#view-reviews');
const viewCompanies = $('#view-companies');
const viewProjects = $('#view-projects');
const tabReviewCount = $('#tab-review-count');
const tabCompanyCount = $('#tab-company-count');
const tabProjectCount = $('#tab-project-count');
const globalStatus = $('#global-status');

const reviewSearch = $('#review-search');
const reviewCompanyFilter = $('#review-company-filter');
const reviewProjectFilter = $('#review-project-filter');
const reviewScoreFilter = $('#review-score-filter');
const reviewRefresh = $('#review-refresh');
const reviewCount = $('#review-count');
const reviewRows = $('#review-rows');

const companySearch = $('#company-search');
const companyRefresh = $('#company-refresh');
const companyCount = $('#company-count');
const companyRows = $('#company-rows');

const projectSearch = $('#project-search');
const projectCompanyFilter = $('#project-company-filter');
const projectNewButton = $('#project-new-button');
const projectRefresh = $('#project-refresh');
const projectCount = $('#project-count');
const projectRows = $('#project-rows');
const projectNewForm = $('#project-new-form');
const newProjectCompany = $('#new-project-company');
const newProjectName = $('#new-project-name');
const newProjectStatus = $('#new-project-status');
const newProjectAdd = $('#new-project-add');
const newProjectCancel = $('#new-project-cancel');

const reviewDialog = $('#review-dialog');
const reviewDialogForm = $('#review-dialog-form');
const reviewDialogMeta = $('#review-dialog-meta');
const reviewDialogCompany = $('#review-dialog-company');
const reviewDialogProject = $('#review-dialog-project');
const reviewDialogScore = $('#review-dialog-score');
const reviewDialogTitle = $('#review-dialog-title-input');
const reviewDialogComment = $('#review-dialog-comment');
const reviewDialogSensitive = $('#review-dialog-sensitive');
const reviewDialogDate = $('#review-dialog-date');
const reviewDialogTenure = $('#review-dialog-tenure');
const reviewDialogTags = $('#review-dialog-tags');
const reviewDialogStatus = $('#review-dialog-status');
const reviewDialogRevert = $('#review-dialog-revert');
const reviewDialogCancel = $('#review-dialog-cancel');
const reviewDialogClose = $('#review-dialog-close');

const companyDialog = $('#company-dialog');
const companyDialogForm = $('#company-dialog-form');
const companyDialogMeta = $('#company-dialog-meta');
const companyDialogName = $('#company-dialog-name');
const companyDialogSlug = $('#company-dialog-slug');
const companyDialogAliases = $('#company-dialog-aliases');
const companyDialogDelete = $('#company-dialog-delete');
const companyDialogDeleteHint = $('#company-dialog-delete-hint');
const companyDialogStatus = $('#company-dialog-status');
const companyDialogCancel = $('#company-dialog-cancel');
const companyDialogClose = $('#company-dialog-close');

const projectDialog = $('#project-dialog');
const projectDialogForm = $('#project-dialog-form');
const projectDialogMeta = $('#project-dialog-meta');
const projectDialogCompany = $('#project-dialog-company');
const projectDialogName = $('#project-dialog-name');
const projectDialogStatusSelect = $('#project-dialog-status');
const projectDialogAliases = $('#project-dialog-aliases');
const projectDialogCancel = $('#project-dialog-cancel');
const projectDialogClose = $('#project-dialog-close');
const projectDialogMessage = $('#project-dialog-message');

const state = {
  client: null,
  api: null,
  taxonomy: null,
  companies: new Map(),
  reviews: new Map(),
  editingReviewId: null,
  editingCompanyId: null,
  editingProject: null,
  pendingReviewIds: new Set(),
  pendingCompanyIds: new Set(),
  pendingProjectKeys: new Set(),
  view: 'reviews',
  busy: false,
};

const initialView = new URLSearchParams(location.search).get('tab');
if (VIEWS.includes(initialView)) state.view = initialView;

// ── 公共小工具 ────────────────────────────────────────────────────────────

function setStatus(element, message, isError = false) {
  element.textContent = message || '';
  element.classList.toggle('error', Boolean(isError));
}

function progress(message) {
  setStatus(appView.hidden ? bootStatus : globalStatus, message);
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

function handleError(error) {
  if (error.status === 401) {
    signOut('登录已失效，请重新登录。');
    return;
  }
  setStatus(globalStatus, describeError(error), true);
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function buildSelect(options, value) {
  const select = h('select', {}, ...options.map(([key, label]) => h('option', { value: key }, label)));
  const exists = options.some(([key]) => key === value);
  select.value = exists ? value : (options[0]?.[0] ?? '');
  return select;
}

function sortedCompanies() {
  return [...state.companies.values()]
    .sort((a, b) => a.data.name.localeCompare(b.data.name, 'zh-CN'));
}

function fillCompanySelect(select, { includeAll = false, allLabel = '全部公司' } = {}) {
  const previous = select.value;
  const options = [];
  if (includeAll) options.push(h('option', { value: '' }, allLabel));
  sortedCompanies().forEach(entry => {
    options.push(h('option', { value: entry.data.id }, entry.data.name));
  });
  select.replaceChildren(...options);
  if (previous && options.some(option => option.value === previous)) select.value = previous;
  else select.value = includeAll ? '' : (options[0]?.value || '');
}

function refreshCompanySelects() {
  fillCompanySelect(reviewCompanyFilter, { includeAll: true });
  fillCompanySelect(projectCompanyFilter, { includeAll: true });
  fillCompanySelect(newProjectCompany);
}

function refreshReviewProjectFilter() {
  const companyId = reviewCompanyFilter.value;
  const previous = reviewProjectFilter.value;
  const options = [h('option', { value: '' }, '全部项目')];
  sortedCompanies().forEach(entry => {
    if (companyId && entry.data.id !== companyId) return;
    (entry.data.projects || []).forEach(project => {
      options.push(h('option', {
        value: project.id,
      }, companyId ? project.name : `${entry.data.name} · ${project.name}`));
    });
  });
  reviewProjectFilter.replaceChildren(...options);
  const exists = options.some(option => option.value === previous);
  reviewProjectFilter.value = exists ? previous : '';
}

function reviewCountForCompany(companyId) {
  let count = 0;
  state.reviews.forEach(entry => {
    if (entry.data.companyId === companyId) count += 1;
  });
  return count;
}

function reviewCountForProject(companyId, projectId) {
  let count = 0;
  state.reviews.forEach(entry => {
    if (entry.data.companyId === companyId
      && !entry.data.projectAnonymous
      && entry.data.projectId === projectId) count += 1;
  });
  return count;
}

function withHidden(data) {
  const next = JSON.parse(JSON.stringify(data));
  if (next.hidden) delete next.hidden;
  else next.hidden = true;
  return next;
}

function hiddenBadge(data) {
  return data.hidden ? h('span', { class: 'badge hidden-badge' }, '已隐藏') : null;
}

function countButton(count, onClick, title = '查看评价列表') {
  return h('button', { type: 'button', class: 'link-button', title, onClick }, `${count} 条`);
}

function setBusy(busy) {
  state.busy = busy;
  appView.classList.toggle('is-busy', busy);
  [viewReviews, viewCompanies, viewProjects].forEach(element => { element.inert = busy; });
  [reviewDialogForm, companyDialogForm, projectDialogForm].forEach(form => { form.inert = busy; });
  reviewRefresh.disabled = busy;
  companyRefresh.disabled = busy;
  projectRefresh.disabled = busy;
}

function pendingBadge(isPending) {
  return isPending ? h('span', { class: 'badge pending-badge' }, '待审核') : null;
}

function updatePendingLink(count = loadChanges().length) {
  pendingChangesLink.textContent = `待审改动（${count}）`;
  pendingChangesLink.classList.toggle('has-items', count > 0);
}

function syncPendingFromChanges(list = loadChanges()) {
  const pending = collectPendingIds(list);
  state.pendingReviewIds = pending.reviewIds;
  state.pendingCompanyIds = pending.companyIds;
  state.pendingProjectKeys = pending.projectKeys;
  updatePendingLink(list.length);
}

function pendingLabels(company) {
  return {
    company: company?.data?.name || '',
    projects: Object.fromEntries(((company?.data?.projects) || []).map(project => [project.id, project.name])),
  };
}

function stageReviewChange(entry, before, after) {
  const company = state.companies.get(before.companyId);
  const list = stageChange({
    path: entry.path,
    kind: 'review',
    reviewId: before.id,
    companyId: before.companyId,
    title: company ? `${company.data.name} · 评价` : `评价 ${before.id}`,
    labels: pendingLabels(company),
    before,
    after,
  });
  syncPendingFromChanges(list);
  return list;
}

function stageCompanyChange(entry, before, after) {
  const label = after || before || {};
  const list = stageChange({
    path: entry.path,
    kind: 'company',
    companyId: label.id || entry.data.id,
    title: label.name || entry.data.name || '公司',
    labels: pendingLabels({ data: label }),
    before,
    after,
  });
  syncPendingFromChanges(list);
  return list;
}

function stagedNotice(count) {
  setStatus(globalStatus, `已保存到待审核（共 ${count} 项），请到审核台批量提交`);
}

// ── 视图切换 ──────────────────────────────────────────────────────────────

function showView(view) {
  if (state.busy) return;
  state.view = view;
  tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.view === view));
  viewReviews.hidden = view !== 'reviews';
  viewCompanies.hidden = view !== 'companies';
  viewProjects.hidden = view !== 'projects';
  try {
    const url = new URL(location.href);
    url.searchParams.set('tab', view);
    history.replaceState(null, '', url);
  } catch {
    // 某些环境禁止修改 URL，忽略即可
  }
  refreshCompanySelects();
  refreshReviewProjectFilter();
  renderAll();
}

function updateTabCounts() {
  tabReviewCount.textContent = String(state.reviews.size);
  tabCompanyCount.textContent = String(state.companies.size);
  let projects = 0;
  state.companies.forEach(entry => { projects += (entry.data.projects || []).length; });
  tabProjectCount.textContent = String(projects);
}

function renderAll() {
  updateTabCounts();
  if (state.view === 'reviews') renderReviews();
  else if (state.view === 'companies') renderCompanies();
  else renderProjects();
}

function hasDirty() {
  return (reviewDialog.open && reviewDialogChanged())
    || (companyDialog.open && companyDialogChanged())
    || (projectDialog.open && projectDialogChanged());
}

// ── 评价表 ────────────────────────────────────────────────────────────────

function reviewProjectName(entry) {
  const data = entry.data;
  if (data.projectAnonymous) return '匿名项目';
  if (!data.projectId) return '未关联';
  const company = state.companies.get(data.companyId);
  const project = (company?.data.projects || []).find(item => item.id === data.projectId);
  return project?.name || `未知项目 ${data.projectId}`;
}

function visibleReviews() {
  const query = reviewSearch.value.trim().toLowerCase();
  const companyId = reviewCompanyFilter.value;
  const projectId = reviewProjectFilter.value;
  const score = reviewScoreFilter.value;
  return [...state.reviews.values()]
    .filter(entry => {
      const data = entry.data;
      if (companyId && data.companyId !== companyId) return false;
      if (projectId && (data.projectAnonymous || data.projectId !== projectId)) return false;
      if (score && String(data.score) !== score) return false;
      if (!query) return true;
      const company = state.companies.get(data.companyId);
      const haystack = [
        company?.data.name,
        company?.data.id,
        reviewProjectName(entry),
        data.title,
        data.comment,
        data.id,
      ].join(' ').toLowerCase();
      return haystack.includes(query);
    })
    .sort((a, b) => (b.data.publishedAt || '').localeCompare(a.data.publishedAt || '')
      || b.data.id.localeCompare(a.data.id));
}

function clip(text, max = 160) {
  const source = String(text || '').replace(/\s+/g, ' ').trim();
  return source.length > max ? `${source.slice(0, max)}…` : source;
}

function buildReviewRow(entry) {
  const data = entry.data;
  const company = state.companies.get(data.companyId) || null;
  const row = h('tr', { dataset: { id: data.id } });

  const reviewCell = h('td', { class: 'cell-review' });
  if (data.title) reviewCell.append(h('strong', {}, data.title));
  reviewCell.append(h('div', { class: 'review-text' }, clip(data.comment)));

  row.append(
    h('td', { class: 'cell-company' },
      h('strong', {}, company?.data.name || '（公司缺失）'),
      h('div', { class: 'cell-id' }, data.companyId || '—')),
    h('td', { class: 'cell-project' },
      reviewProjectName(entry), ' ', hiddenBadge(data), ' ', pendingBadge(state.pendingReviewIds.has(data.id))),
    reviewCell,
    h('td', { class: 'cell-narrow' }, `${Number(data.score) || '—'} 星`),
    h('td', { class: 'cell-narrow' }, data.publishedAt || '—'),
    h('td', { class: 'row-actions' },
      h('button', {
        type: 'button',
        class: 'ghost small',
        onClick: () => openReviewDialog(data.id),
      }, '修改'),
      h('button', {
        type: 'button',
        class: 'danger small',
        onClick: () => deleteReview(data.id),
      }, '删除'),
      h('button', {
        type: 'button',
        class: 'ghost small',
        onClick: () => toggleReviewHidden(data.id),
      }, data.hidden ? '显示' : '隐藏')),
  );
  row.classList.toggle('is-hidden', Boolean(data.hidden));
  return row;
}

function renderReviews() {
  updateTabCounts();
  const entries = visibleReviews();
  reviewRows.replaceChildren();
  if (!entries.length) {
    reviewRows.append(h('tr', {}, h('td', { class: 'empty', colSpan: 6 }, '没有匹配的评价')));
  } else {
    entries.forEach(entry => reviewRows.append(buildReviewRow(entry)));
  }
  reviewCount.textContent = `显示 ${entries.length} / 共 ${state.reviews.size} 条`;
}

function openCompanyReviews(companyId) {
  reviewCompanyFilter.value = companyId;
  refreshReviewProjectFilter();
  showView('reviews');
}

function openProjectReviews(companyId, projectId) {
  reviewCompanyFilter.value = companyId;
  refreshReviewProjectFilter();
  reviewProjectFilter.value = projectId;
  showView('reviews');
}

// ── 评价编辑弹窗 ──────────────────────────────────────────────────────────

function currentReviewEntry() {
  return state.editingReviewId ? state.reviews.get(state.editingReviewId) || null : null;
}

function renderReviewDialogOptions() {
  reviewDialogTenure.replaceChildren(
    h('option', { value: '' }, '不填'),
    ...(state.taxonomy?.tenures || []).map(item => h('option', { value: item.key }, item.label)),
  );
  reviewDialogTags.replaceChildren(
    ...(state.taxonomy?.tags || []).map(tag =>
      h('label', {}, h('input', { type: 'checkbox', value: tag.key }), tag.label)),
  );
}

function fillReviewDialog() {
  const entry = currentReviewEntry();
  if (!entry) return;
  const data = entry.data;
  const company = state.companies.get(data.companyId);

  reviewDialogMeta.textContent = `${data.id} · v${Number(data.revision) || 1}`;
  reviewDialogCompany.value = company?.data.name || '（公司缺失）';

  const selected = data.projectAnonymous ? '__anon' : (data.projectId || '__none');
  const options = [['__none', '不关联项目'], ['__anon', '匿名项目']];
  (company?.data.projects || []).forEach(project => options.push([project.id, project.name]));
  if (!['__none', '__anon'].includes(selected)
    && !(company?.data.projects || []).some(project => project.id === selected)) {
    options.push([selected, `未知项目 ${selected}`]);
  }
  reviewDialogProject.replaceChildren(...options.map(([value, label]) => h('option', { value }, label)));
  reviewDialogProject.value = selected;

  reviewDialogScore.value = String(data.score || 3);
  reviewDialogTitle.value = data.title || '';
  reviewDialogComment.value = data.comment || '';
  reviewDialogDate.value = data.publishedAt || '';
  reviewDialogTenure.value = data.profile?.tenure || '';
  reviewDialogTags.querySelectorAll('input').forEach(input => {
    input.checked = (data.tags || []).includes(input.value);
  });
  setStatus(reviewDialogStatus, '');
  refreshDialogSensitive();
}

function openReviewDialog(id) {
  if (state.busy) return;
  const entry = state.reviews.get(id);
  if (!entry) return;
  state.editingReviewId = id;
  fillReviewDialog();
  reviewDialog.showModal();
  reviewDialogComment.focus();
}

function collectReviewDialogFields() {
  const choice = reviewDialogProject.value;
  const projectAnonymous = choice === '__anon';
  return {
    score: Number(reviewDialogScore.value),
    title: reviewDialogTitle.value.trim(),
    comment: reviewDialogComment.value.trim(),
    projectId: choice === '__none' || projectAnonymous ? '' : choice,
    projectAnonymous,
    tenure: reviewDialogTenure.value,
    tags: [...reviewDialogTags.querySelectorAll('input:checked')].map(input => input.value),
    publishedAt: reviewDialogDate.value,
  };
}

function reviewDialogChanged() {
  const entry = currentReviewEntry();
  if (!entry) return false;
  return reviewContentChanged(entry.data, composeReview(entry.data, collectReviewDialogFields()));
}

function closeReviewDialog() {
  if (reviewDialogChanged() && !window.confirm('评价有未保存的修改，确定放弃？')) return;
  state.editingReviewId = null;
  reviewDialog.close();
}

function refreshDialogSensitive() {
  const result = scanDraft({ comment: reviewDialogComment.value, title: reviewDialogTitle.value });
  const hard = result.hits.filter(hit => hit.level === 'hard');
  const soft = result.hits.filter(hit => hit.level === 'soft');
  const parts = [];
  if (hard.length) {
    parts.push(`禁止保存：${hard.map(hit => `${hit.field}有${hit.type}「${clip(hit.fragment, 20)}」`).join('、')}`);
  }
  if (soft.length) {
    parts.push(`提醒：${soft.map(hit => `${hit.field}疑似${hit.type}「${clip(hit.fragment, 20)}」`).join('、')}`);
  }
  setStatus(reviewDialogSensitive, parts.join('；'));
  reviewDialogSensitive.classList.toggle('blocked', hard.length > 0);
  reviewDialogSensitive.classList.toggle('warn', !hard.length && soft.length > 0);
}

async function saveReviewDialog(event) {
  event.preventDefault();
  if (state.busy) return;
  const entry = currentReviewEntry();
  if (!entry) return;
  const company = state.companies.get(entry.data.companyId);
  if (!company) {
    setStatus(reviewDialogStatus, '所属公司不存在，无法保存', true);
    return;
  }

  const fields = collectReviewDialogFields();
  const profile = { ...(entry.data.profile || {}) };
  if (fields.tenure) profile.tenure = fields.tenure;
  else delete profile.tenure;

  const errors = validateDraft({
    companyId: entry.data.companyId,
    projectId: fields.projectId,
    projectAnonymous: fields.projectAnonymous,
    score: fields.score,
    title: fields.title,
    comment: fields.comment,
    profile,
    tags: fields.tags,
    publishedAt: fields.publishedAt,
  }, { taxonomy: state.taxonomy, company: company.data });

  if (scanDraft({ comment: fields.comment, title: fields.title }).hasHard) {
    errors.push('正文或标题仍含手机号 / 邮箱 / 身份证号，请脱敏后再保存');
  }
  if (errors.length) {
    setStatus(reviewDialogStatus, errors.join('；'), true);
    return;
  }

  const next = composeReview(entry.data, fields);
  if (!reviewContentChanged(entry.data, next)) {
    setStatus(reviewDialogStatus, '没有改动');
    return;
  }

  const list = stageReviewChange(entry, entry.data, next);
  entry.data = next;
  renderReviews();
  stagedNotice(list.length);
  state.editingReviewId = null;
  reviewDialog.close();
}

async function deleteReview(id) {
  if (state.busy) return;
  const entry = state.reviews.get(id);
  if (!entry) return;
  if (!window.confirm(`确认删除评价 ${id}？改动会先进入待审核列表。`)) return;
  const list = stageReviewChange(entry, entry.data, null);
  state.reviews.delete(id);
  stagedNotice(list.length);
  renderAll();
}

async function toggleReviewHidden(id) {
  if (state.busy) return;
  const entry = state.reviews.get(id);
  if (!entry) return;
  const before = entry.data;
  const next = withHidden(before);
  const list = stageReviewChange(entry, before, next);
  entry.data = next;
  stagedNotice(list.length);
  renderAll();
}

// ── 公司表 ────────────────────────────────────────────────────────────────

function buildCompanyRow(entry) {
  const data = entry.data;
  const row = h('tr', { dataset: { id: data.id } });
  const aliases = (data.aliases || []).join('、') || '—';

  row.append(
    h('td', { class: 'cell-company' },
      h('strong', {}, data.name || '—'), ' ', hiddenBadge(data), ' ', pendingBadge(state.pendingCompanyIds.has(data.id))),
    h('td', { class: 'cell-aliases' }, aliases),
    h('td', { class: 'cell-narrow' }, String((data.projects || []).length)),
    h('td', { class: 'cell-narrow' }, countButton(reviewCountForCompany(data.id), () => openCompanyReviews(data.id))),
    h('td', { class: 'cell-narrow' }, data.updatedAt || '—'),
    h('td', { class: 'row-actions' },
      h('button', {
        type: 'button',
        class: 'ghost small',
        onClick: () => openCompanyDialog(data.id),
      }, '修改'),
      h('button', {
        type: 'button',
        class: 'ghost small',
        onClick: () => toggleCompanyHidden(data.id),
      }, data.hidden ? '显示' : '隐藏')),
  );
  row.classList.toggle('is-hidden', Boolean(data.hidden));
  return row;
}

function renderCompanies() {
  updateTabCounts();
  const query = companySearch.value.trim().toLowerCase();
  const entries = sortedCompanies().filter((entry) => {
    const data = entry.data;
    if (!query) return true;
    const haystack = [data.name, data.id, data.slug, ...(data.aliases || [])].join(' ').toLowerCase();
    return haystack.includes(query);
  });

  companyRows.replaceChildren();
  if (!entries.length) {
    companyRows.append(h('tr', {}, h('td', { class: 'empty', colSpan: 6 }, '没有匹配的公司')));
  } else {
    entries.forEach(entry => companyRows.append(buildCompanyRow(entry)));
  }
  companyCount.textContent = `显示 ${entries.length} / 共 ${state.companies.size} 家`;
}

function currentCompanyEntry() {
  return state.editingCompanyId ? state.companies.get(state.editingCompanyId) || null : null;
}

function fillCompanyDialog() {
  const entry = currentCompanyEntry();
  if (!entry) return;
  const data = entry.data;
  const reviewCount = reviewCountForCompany(data.id);
  companyDialogMeta.textContent = `${data.id} · ${(data.projects || []).length} 个项目 · ${reviewCount} 条评价`;
  companyDialogName.value = data.name || '';
  companyDialogSlug.value = data.slug || '';
  companyDialogAliases.value = (data.aliases || []).join('，');

  const blocked = (data.projects || []).length > 0 || reviewCount > 0;
  companyDialogDelete.disabled = blocked;
  setStatus(companyDialogDeleteHint, blocked
    ? '公司下仍有项目或评价，全部清空后才能删除。'
    : '公司下没有项目和评价，可以删除。');
  setStatus(companyDialogStatus, '');
}

function openCompanyDialog(id) {
  if (state.busy) return;
  const entry = state.companies.get(id);
  if (!entry) return;
  state.editingCompanyId = id;
  fillCompanyDialog();
  companyDialog.showModal();
  companyDialogName.focus();
}

function companyDialogChanged() {
  const entry = currentCompanyEntry();
  if (!entry) return false;
  const data = entry.data;
  const aliasesOf = list => parseAliases((list || []).join('，')).join('\u0000');
  return (data.name || '') !== companyDialogName.value.trim()
    || (data.slug || '') !== companyDialogSlug.value.trim()
    || aliasesOf(data.aliases || []) !== aliasesOf(parseAliases(companyDialogAliases.value));
}

function closeCompanyDialog() {
  if (companyDialogChanged() && !window.confirm('公司信息有未保存的修改，确定放弃？')) return;
  state.editingCompanyId = null;
  companyDialog.close();
}

async function saveCompanyDialog(event) {
  event.preventDefault();
  if (state.busy) return;
  const entry = currentCompanyEntry();
  if (!entry) return;

  const next = composeCompany(entry.data, {
    name: companyDialogName.value.trim(),
    slug: companyDialogSlug.value.trim(),
    aliases: parseAliases(companyDialogAliases.value),
    projects: entry.data.projects || [],
  });

  const errors = validateCompany(next);
  const slugTaken = [...state.companies.values()]
    .some(other => other.data.id !== next.id && other.data.slug === next.slug);
  if (slugTaken) errors.push(`slug「${next.slug}」已被其他公司使用`);
  if (errors.length) {
    setStatus(companyDialogStatus, errors.join('；'), true);
    return;
  }
  if (!companyContentChanged(entry.data, next)) {
    setStatus(companyDialogStatus, '没有改动');
    return;
  }

  const list = stageCompanyChange(entry, entry.data, next);
  entry.data = next;
  renderAll();
  stagedNotice(list.length);
  state.editingCompanyId = null;
  companyDialog.close();
}

async function deleteCompany() {
  if (state.busy) return;
  const entry = currentCompanyEntry();
  if (!entry) return;
  const data = entry.data;
  const projectCount = (data.projects || []).length;
  const reviews = reviewCountForCompany(data.id);
  if (projectCount > 0 || reviews > 0) {
    setStatus(companyDialogDeleteHint, '公司下仍有项目或评价，不能删除。', true);
    return;
  }
  if (!window.confirm(`确认删除公司「${data.name}」？改动会先进入待审核列表。`)) return;

  const list = stageCompanyChange(entry, entry.data, null);
  state.companies.delete(data.id);
  state.editingCompanyId = null;
  companyDialog.close();
  stagedNotice(list.length);
  renderAll();
}

async function toggleCompanyHidden(id) {
  if (state.busy) return;
  const entry = state.companies.get(id);
  if (!entry) return;
  const before = entry.data;
  const next = withHidden(before);
  const list = stageCompanyChange(entry, before, next);
  entry.data = next;
  stagedNotice(list.length);
  renderAll();
}

// ── 项目表 ────────────────────────────────────────────────────────────────

function projectStatusLabel(status) {
  return PROJECT_STATUS_LABEL[status] || status || '—';
}

function currentProjectContext() {
  if (!state.editingProject) return null;
  const { companyId, projectId } = state.editingProject;
  const entry = state.companies.get(companyId);
  if (!entry) return null;
  const project = (entry.data.projects || []).find(item => item.id === projectId);
  if (!project) return null;
  return { entry, project };
}

function buildProjectRow(companyEntry, project) {
  const data = companyEntry.data;
  const row = h('tr', { dataset: { company: data.id, project: project.id } });
  const aliases = (project.aliases || []).join('、') || '—';
  const count = reviewCountForProject(data.id, project.id);

  row.append(
    h('td', { class: 'cell-title' },
      h('strong', {}, project.name), ' ', hiddenBadge(project), ' ',
      pendingBadge(state.pendingProjectKeys.has(`${data.id}:${project.id}`))),
    h('td', { class: 'cell-aliases' }, aliases),
    h('td', { class: 'cell-company' }, data.name),
    h('td', { class: 'cell-narrow' }, projectStatusLabel(project.status)),
    h('td', { class: 'cell-narrow' }, countButton(count, () => openProjectReviews(data.id, project.id))),
    h('td', { class: 'row-actions' },
      h('button', {
        type: 'button',
        class: 'ghost small',
        onClick: () => openProjectDialog(data.id, project.id),
      }, '修改'),
      h('button', {
        type: 'button',
        class: 'danger small',
        onClick: () => deleteProject(data.id, project.id),
      }, '删除'),
      h('button', {
        type: 'button',
        class: 'ghost small',
        onClick: () => toggleProjectHidden(data.id, project.id),
      }, project.hidden ? '显示' : '隐藏')),
  );
  row.classList.toggle('is-hidden', Boolean(project.hidden));
  return row;
}

function renderProjects() {
  updateTabCounts();
  const query = projectSearch.value.trim().toLowerCase();
  const companyId = projectCompanyFilter.value;
  const rows = [];
  sortedCompanies().forEach(entry => {
    if (companyId && entry.data.id !== companyId) return;
    (entry.data.projects || []).forEach(project => {
      const haystack = [
        entry.data.name,
        entry.data.id,
        project.name,
        project.id,
        ...(project.aliases || []),
      ].join(' ').toLowerCase();
      if (query && !haystack.includes(query)) return;
      rows.push({ entry, project });
    });
  });

  projectRows.replaceChildren();
  if (!rows.length) {
    projectRows.append(h('tr', {}, h('td', { class: 'empty', colSpan: 6 }, '没有匹配的项目')));
  } else {
    rows.forEach(({ entry, project }) => projectRows.append(buildProjectRow(entry, project)));
  }
  let total = 0;
  state.companies.forEach(entry => { total += (entry.data.projects || []).length; });
  projectCount.textContent = `显示 ${rows.length} / 共 ${total} 个项目`;
}

function fillProjectDialog() {
  const context = currentProjectContext();
  if (!context) return;
  const { entry, project } = context;
  const count = reviewCountForProject(entry.data.id, project.id);
  projectDialogMeta.textContent = `${project.id} · ${count} 条评价`;
  projectDialogCompany.value = entry.data.name;
  projectDialogName.value = project.name || '';
  projectDialogStatusSelect.value = project.status || 'unknown';
  projectDialogAliases.value = (project.aliases || []).join('，');
  setStatus(projectDialogMessage, '');
}

function openProjectDialog(companyId, projectId) {
  if (state.busy) return;
  const entry = state.companies.get(companyId);
  if (!entry) return;
  if (!(entry.data.projects || []).some(project => project.id === projectId)) return;
  state.editingProject = { companyId, projectId };
  fillProjectDialog();
  projectDialog.showModal();
  projectDialogName.focus();
}

function projectDialogChanged() {
  const context = currentProjectContext();
  if (!context) return false;
  const { project } = context;
  const aliasesOf = list => parseAliases((list || []).join('，')).join('\u0000');
  return (project.name || '') !== projectDialogName.value.trim()
    || (project.status || 'unknown') !== projectDialogStatusSelect.value
    || aliasesOf(project.aliases || []) !== aliasesOf(parseAliases(projectDialogAliases.value));
}

function closeProjectDialog() {
  if (projectDialogChanged() && !window.confirm('项目信息有未保存的修改，确定放弃？')) return;
  state.editingProject = null;
  projectDialog.close();
}

function applyProjectChange(entry, projectId, updater) {
  const projects = (entry.data.projects || [])
    .map(project => (project.id === projectId ? updater(project) : project))
    .filter(Boolean);
  return composeCompany(entry.data, {
    name: entry.data.name,
    slug: entry.data.slug,
    aliases: entry.data.aliases || [],
    projects,
  });
}

async function saveProjectDialog(event) {
  event.preventDefault();
  if (state.busy) return;
  const context = currentProjectContext();
  if (!context) return;
  const { entry, project } = context;

  const nextProject = composeProject(project, {
    name: projectDialogName.value.trim(),
    aliases: parseAliases(projectDialogAliases.value),
    status: projectDialogStatusSelect.value,
  });
  const next = applyProjectChange(entry, project.id, () => nextProject);

  const errors = validateCompany(next);
  if (errors.length) {
    setStatus(projectDialogMessage, errors.join('；'), true);
    return;
  }
  if (!companyContentChanged(entry.data, next)) {
    setStatus(projectDialogMessage, '没有改动');
    return;
  }

  const list = stageCompanyChange(entry, entry.data, next);
  entry.data = next;
  renderAll();
  stagedNotice(list.length);
  state.editingProject = null;
  projectDialog.close();
}

async function deleteProject(companyId, projectId) {
  if (state.busy) return;
  const entry = state.companies.get(companyId);
  if (!entry) return;
  const project = (entry.data.projects || []).find(item => item.id === projectId);
  if (!project) return;
  const count = reviewCountForProject(companyId, projectId);
  if (count > 0) {
    setStatus(globalStatus, '该项目下已有展示评价，不能删除', true);
    return;
  }
  if (!window.confirm(`确认删除项目「${project.name}」？改动会先进入待审核列表。`)) return;

  const before = entry.data;
  const next = applyProjectChange(entry, projectId, () => null);
  const list = stageCompanyChange(entry, before, next);
  entry.data = next;
  stagedNotice(list.length);
  renderAll();
}

async function toggleProjectHidden(companyId, projectId) {
  if (state.busy) return;
  const entry = state.companies.get(companyId);
  if (!entry) return;
  const project = (entry.data.projects || []).find(item => item.id === projectId);
  if (!project) return;
  const before = entry.data;
  const nextProject = withHidden(project);
  const next = applyProjectChange(entry, projectId, () => nextProject);
  const list = stageCompanyChange(entry, before, next);
  entry.data = next;
  stagedNotice(list.length);
  renderAll();
}

// ── 新增项目 ──────────────────────────────────────────────────────────────

function openNewProjectForm() {
  projectNewForm.hidden = false;
  fillCompanySelect(newProjectCompany);
  if (projectCompanyFilter.value) newProjectCompany.value = projectCompanyFilter.value;
  newProjectName.value = '';
  newProjectStatus.value = 'live';
  newProjectName.focus();
}

async function addProject() {
  if (state.busy) return;
  const companyId = newProjectCompany.value;
  const name = newProjectName.value.trim();
  if (!companyId) {
    setStatus(globalStatus, '请选择所属公司', true);
    return;
  }
  if (!name || name.length > 50) {
    setStatus(globalStatus, '项目名不能为空且不超过 50 字', true);
    return;
  }
  const entry = state.companies.get(companyId);
  if (!entry) return;

  const existingIds = new Set((entry.data.projects || []).map(project => project.id));
  const id = newProjectId(name, existingIds);
  const project = { id, name, status: newProjectStatus.value };
  const next = composeCompany(entry.data, {
    name: entry.data.name,
    slug: entry.data.slug,
    aliases: entry.data.aliases || [],
    projects: [...(entry.data.projects || []), project],
  });

  const errors = validateCompany(next);
  if (errors.length) {
    setStatus(globalStatus, errors.join('；'), true);
    return;
  }

  const list = stageCompanyChange(entry, entry.data, next);
  entry.data = next;
  projectNewForm.hidden = true;
  stagedNotice(list.length);
  renderAll();
}

// ── 数据加载 ──────────────────────────────────────────────────────────────

async function loadData() {
  progress('正在读取公开仓数据…');
  const [taxonomyFile, tree] = await Promise.all([
    state.client.getFile(config.owner, config.publicRepo, config.taxonomyPath, config.publicBranch),
    state.client.getTree(config.owner, config.publicRepo, config.publicBranch),
  ]);
  if (!taxonomyFile) throw new Error('公开仓缺少 taxonomy.json');
  state.taxonomy = parseJson(taxonomyFile.content, config.taxonomyPath);

  const companyPaths = (tree.tree || [])
    .filter(item => item.type === 'blob'
      && item.path.startsWith(`${config.companiesDir}/`)
      && item.path.endsWith('.json'))
    .map(item => item.path);
  const companyFiles = await mapLimit(companyPaths, 6, async (path) => {
    const file = await state.client.getFile(config.owner, config.publicRepo, path, config.publicBranch);
    if (!file) return null;
    return { path: file.path, sha: file.sha, data: parseJson(file.content, file.path) };
  });
  state.companies = new Map(companyFiles.filter(Boolean).map(entry => [entry.data.id, entry]));

  const reviewPaths = (tree.tree || [])
    .filter(item => item.type === 'blob'
      && item.path.startsWith(`${config.reviewsDir}/`)
      && item.path.endsWith('.json'))
    .map(item => item.path);

  let done = 0;
  const reviewFiles = await mapLimit(reviewPaths, 6, async (path) => {
    try {
      const file = await state.client.getFile(config.owner, config.publicRepo, path, config.publicBranch);
      done += 1;
      if (done === reviewPaths.length || done % 10 === 0) {
        progress(`正在读取评价 ${done}/${reviewPaths.length}…`);
      }
      if (!file) return null;
      return { path: file.path, sha: file.sha, data: parseJson(file.content, file.path) };
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  });
  state.reviews = new Map(reviewFiles.filter(Boolean).map(entry => [entry.data.id, entry]));

  const changes = loadChanges();
  const pending = applyChangesToData(changes, state);
  state.pendingReviewIds = pending.reviewIds;
  state.pendingCompanyIds = pending.companyIds;
  state.pendingProjectKeys = pending.projectKeys;
  updatePendingLink(changes.length);

  state.editingReviewId = null;
  state.editingCompanyId = null;
  state.editingProject = null;

  renderReviewDialogOptions();
  refreshReviewProjectFilter();
}

// ── 登录 ──────────────────────────────────────────────────────────────────

async function signIn(token, { silent = false } = {}) {
  if (!token) {
    clearSession();
    showLogin();
    return;
  }
  const cached = silent ? getSession() : null;
  let authenticated = Boolean(cached);
  showBoot(cached
    ? '正在读取数据…'
    : (silent ? '正在验证登录状态，无需重新输入 token…' : '正在登录…'));
  try {
    const client = createClient(token);
    const api = createApi(token);
    let login = cached?.login || '';
    if (!cached) {
      const me = await api.me();
      login = me.login;
      authenticated = true;
      setSession(login);
    }

    setToken(token);
    state.client = client;
    state.api = api;
    userLabel.textContent = login ? `@${login}` : '';
    showBoot('登录有效，正在读取数据…');
    await loadData();
    showApp();
    showView(state.view);
    setStatus(loginStatus, '');
    setStatus(globalStatus, `已加载 ${state.companies.size} 家公司、${state.reviews.size} 条评价；修改保存后展示站会自动重建`);
  } catch (error) {
    state.client = null;
    state.api = null;
    if (error.status === 401) {
      clearToken();
      clearSession();
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
  clearSession();
  state.client = null;
  state.api = null;
  state.taxonomy = null;
  state.companies = new Map();
  state.reviews = new Map();
  state.editingReviewId = null;
  state.editingCompanyId = null;
  state.editingProject = null;
  state.pendingReviewIds = new Set();
  state.pendingCompanyIds = new Set();
  state.pendingProjectKeys = new Set();
  state.busy = false;
  userLabel.textContent = '';
  updatePendingLink();
  reviewRows.replaceChildren();
  companyRows.replaceChildren();
  projectRows.replaceChildren();
  reviewCount.textContent = '';
  companyCount.textContent = '';
  projectCount.textContent = '';
  [reviewDialog, companyDialog, projectDialog].forEach(dialog => {
    if (dialog.open) dialog.close();
  });
  [reviewDialogForm, companyDialogForm, projectDialogForm].forEach(form => { form.inert = false; });
  projectNewForm.hidden = true;
  showLogin(message);
  setStatus(globalStatus, '');
}

async function refreshData() {
  if (state.busy || !state.client) return;
  if (hasDirty() && !window.confirm('有未保存的修改，刷新将丢弃，确定继续？')) return;
  setBusy(true);
  try {
    await loadData();
    refreshCompanySelects();
    refreshReviewProjectFilter();
    renderAll();
    setStatus(globalStatus, `已刷新：${state.companies.size} 家公司、${state.reviews.size} 条评价`);
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

// ── 事件绑定 ──────────────────────────────────────────────────────────────

loginForm.addEventListener('submit', event => {
  event.preventDefault();
  signIn(tokenInput.value.trim());
});
logoutButton.addEventListener('click', () => {
  if (state.busy) return;
  signOut();
});
bootRetry.addEventListener('click', () => {
  const token = getToken();
  if (token) signIn(token, { silent: true });
  else showLogin();
});
bootLogin.addEventListener('click', () => {
  clearToken();
  clearSession();
  showLogin();
  tokenInput.focus();
});

tabs.forEach(tab => tab.addEventListener('click', () => showView(tab.dataset.view)));

reviewSearch.addEventListener('input', renderReviews);
reviewCompanyFilter.addEventListener('change', () => {
  refreshReviewProjectFilter();
  renderReviews();
});
reviewProjectFilter.addEventListener('change', renderReviews);
reviewScoreFilter.addEventListener('change', renderReviews);
reviewRefresh.addEventListener('click', refreshData);

companySearch.addEventListener('input', renderCompanies);
companyRefresh.addEventListener('click', refreshData);

projectSearch.addEventListener('input', renderProjects);
projectCompanyFilter.addEventListener('change', renderProjects);
projectNewButton.addEventListener('click', () => {
  if (projectNewForm.hidden) openNewProjectForm();
  else projectNewForm.hidden = true;
});
projectRefresh.addEventListener('click', refreshData);
newProjectAdd.addEventListener('click', addProject);
newProjectCancel.addEventListener('click', () => { projectNewForm.hidden = true; });
newProjectName.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addProject();
  }
});

reviewDialogForm.addEventListener('submit', saveReviewDialog);
reviewDialogCancel.addEventListener('click', closeReviewDialog);
reviewDialogClose.addEventListener('click', closeReviewDialog);
reviewDialogRevert.addEventListener('click', () => {
  fillReviewDialog();
  setStatus(reviewDialogStatus, '已还原为已保存内容');
});
reviewDialogComment.addEventListener('input', refreshDialogSensitive);
reviewDialogTitle.addEventListener('input', refreshDialogSensitive);
reviewDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeReviewDialog();
});

companyDialogForm.addEventListener('submit', saveCompanyDialog);
companyDialogCancel.addEventListener('click', closeCompanyDialog);
companyDialogClose.addEventListener('click', closeCompanyDialog);
companyDialogDelete.addEventListener('click', deleteCompany);
companyDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeCompanyDialog();
});

projectDialogForm.addEventListener('submit', saveProjectDialog);
projectDialogCancel.addEventListener('click', closeProjectDialog);
projectDialogClose.addEventListener('click', closeProjectDialog);
projectDialog.addEventListener('cancel', event => {
  event.preventDefault();
  closeProjectDialog();
});

window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY) return;
  syncPendingFromChanges(loadChanges());
  renderAll();
  setStatus(globalStatus, '待审核改动已在其他页面更新；点「刷新」同步最新数据');
});

window.addEventListener('beforeunload', event => {
  if (!hasDirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

updatePendingLink();

const savedToken = getToken();
if (savedToken) signIn(savedToken, { silent: true });
else {
  clearSession();
  showLogin();
}
