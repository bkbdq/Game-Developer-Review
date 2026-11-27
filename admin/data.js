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
  referencedProjectIds,
  composeCompany,
  companyContentChanged,
  newProjectId,
  reviewSnapshot,
  reviewSnapshotChanged,
  projectSnapshot,
  projectSnapshotKey,
  composeProjects,
} from './lib/published.js';

const PROJECT_STATUSES = [
  ['live', '已上线'],
  ['dev', '在研'],
  ['cancelled', '已取消'],
  ['unknown', '状态未知'],
];

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
const reviewScoreFilter = $('#review-score-filter');
const reviewDirtyOnly = $('#review-dirty-only');
const reviewSaveButton = $('#review-save-button');
const reviewRefresh = $('#review-refresh');
const reviewCount = $('#review-count');
const reviewBatch = $('#review-batch');
const batchSelected = $('#batch-selected');
const batchScore = $('#batch-score');
const batchProject = $('#batch-project');
const batchDate = $('#batch-date');
const batchTenure = $('#batch-tenure');
const batchTagsMode = $('#batch-tags-mode');
const batchTags = $('#batch-tags');
const batchApply = $('#batch-apply');
const batchClear = $('#batch-clear');
const reviewSelectAll = $('#review-select-all');
const reviewRows = $('#review-rows');

const companySearch = $('#company-search');
const companyDirtyOnly = $('#company-dirty-only');
const companySaveButton = $('#company-save-button');
const companyRefresh = $('#company-refresh');
const companyCount = $('#company-count');
const companyRows = $('#company-rows');

const projectSearch = $('#project-search');
const projectCompanyFilter = $('#project-company-filter');
const projectNewButton = $('#project-new-button');
const projectSaveButton = $('#project-save-button');
const projectRefresh = $('#project-refresh');
const projectCount = $('#project-count');
const projectRows = $('#project-rows');
const projectNewForm = $('#project-new-form');
const newProjectCompany = $('#new-project-company');
const newProjectName = $('#new-project-name');
const newProjectStatus = $('#new-project-status');
const newProjectAdd = $('#new-project-add');
const newProjectCancel = $('#new-project-cancel');

const state = {
  client: null,
  api: null,
  taxonomy: null,
  companies: new Map(),
  reviews: new Map(),
  reviewDrafts: new Map(),
  companyDrafts: new Map(),
  projectDrafts: new Map(),
  selected: new Set(),
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

async function logAudit(action, payload) {
  try {
    await state.api.logEvent({ action, ...payload });
  } catch {
    // 审计写入失败不影响保存结果
  }
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
    if (entry.data.companyId === companyId && !entry.data.projectAnonymous && entry.data.projectId === projectId) count += 1;
  });
  return count;
}

function setBusy(busy) {
  state.busy = busy;
  appView.classList.toggle('is-busy', busy);
  [viewReviews, viewCompanies, viewProjects].forEach(element => { element.inert = busy; });
  reviewRefresh.disabled = busy;
  companyRefresh.disabled = busy;
  projectRefresh.disabled = busy;
  updateReviewSaveButton();
  updateCompanySaveButton();
  updateProjectSaveButton();
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
  renderAll();
}

function updateTabCounts() {
  tabReviewCount.textContent = String(state.reviews.size);
  tabCompanyCount.textContent = String(state.companies.size);
  let projects = 0;
  state.projectDrafts.forEach(rows => { projects += rows.length; });
  tabProjectCount.textContent = String(projects);
}

function renderAll() {
  updateTabCounts();
  if (state.view === 'reviews') renderReviews();
  else if (state.view === 'companies') renderCompanies();
  else renderProjects();
}

function hasDirty() {
  return reviewDirtyIds().length > 0
    || dirtyCompanyIds().length > 0
    || dirtyProjectCompanyIds().length > 0;
}

// ── 评价表 ────────────────────────────────────────────────────────────────

function isReviewDirty(id) {
  const entry = state.reviews.get(id);
  const draft = state.reviewDrafts.get(id);
  return Boolean(entry && draft && reviewSnapshotChanged(entry.data, draft));
}

function reviewDirtyIds() {
  return [...state.reviews.keys()].filter(id => isReviewDirty(id));
}

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
  const score = reviewScoreFilter.value;
  const dirtyOnly = reviewDirtyOnly.checked;
  return [...state.reviews.values()]
    .filter(entry => {
      const data = entry.data;
      if (companyId && data.companyId !== companyId) return false;
      if (score && String(data.score) !== score) return false;
      if (dirtyOnly && !isReviewDirty(data.id)) return false;
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

function bindDraftInput(row, id, element, apply, eventName = 'input') {
  element.addEventListener(eventName, () => {
    apply();
    row.classList.toggle('dirty', isReviewDirty(id));
    updateReviewSaveButton();
  });
}

function buildTagCell(row, id, draft) {
  const tags = state.taxonomy?.tags || [];
  const summary = h('summary');
  const paintSummary = () => {
    const labels = tags.filter(tag => draft.tags.includes(tag.key)).map(tag => tag.label);
    summary.textContent = labels.length ? labels.join('、') : '无标签';
  };
  const box = h('div', { class: 'checks tag-checks' });
  tags.forEach(tag => {
    const checkbox = h('input', { type: 'checkbox', value: tag.key });
    checkbox.checked = draft.tags.includes(tag.key);
    checkbox.addEventListener('change', () => {
      const next = new Set(draft.tags);
      if (checkbox.checked) next.add(tag.key);
      else next.delete(tag.key);
      draft.tags = [...next].sort();
      paintSummary();
      row.classList.toggle('dirty', isReviewDirty(id));
      updateReviewSaveButton();
    });
    box.append(h('label', {}, checkbox, tag.label));
  });
  paintSummary();
  return h('td', { class: 'cell-tags' }, h('details', { class: 'tag-picker' }, summary, box));
}

function buildReviewRow(entry) {
  const id = entry.data.id;
  const data = entry.data;
  const company = state.companies.get(data.companyId) || null;
  const draft = state.reviewDrafts.get(id) || reviewSnapshot(data);
  const row = h('tr', { dataset: { id } });

  const selectBox = h('input', { type: 'checkbox', class: 'review-select', 'aria-label': `选择评价 ${id}` });
  selectBox.checked = state.selected.has(id);
  selectBox.addEventListener('change', () => {
    if (selectBox.checked) state.selected.add(id);
    else state.selected.delete(id);
    syncSelectAll();
    renderBatchBar();
  });
  row.append(h('td', { class: 'cell-select' }, selectBox));

  row.append(h('td', { class: 'cell-company' },
    h('strong', {}, company?.data.name || '（公司缺失）'),
    h('div', { class: 'cell-id' }, data.companyId || '—')));

  const projectOptions = [['__none', '不关联项目'], ['__anon', '匿名项目']];
  (company?.data.projects || []).forEach(project => projectOptions.push([project.id, project.name]));
  if (!['__none', '__anon'].includes(draft.project)
    && !(company?.data.projects || []).some(project => project.id === draft.project)) {
    projectOptions.push([draft.project, `未知项目 ${draft.project}`]);
  }
  const projectSelect = buildSelect(projectOptions, draft.project);
  bindDraftInput(row, id, projectSelect, () => { draft.project = projectSelect.value; }, 'change');
  row.append(h('td', {}, projectSelect));

  const scoreSelect = buildSelect([['5', '5'], ['4', '4'], ['3', '3'], ['2', '2'], ['1', '1']], draft.score);
  bindDraftInput(row, id, scoreSelect, () => { draft.score = scoreSelect.value; }, 'change');
  row.append(h('td', { class: 'cell-narrow' }, scoreSelect));

  const titleInput = h('input', { type: 'text', maxLength: 40, value: draft.title, autocomplete: 'off' });
  bindDraftInput(row, id, titleInput, () => { draft.title = titleInput.value; });
  row.append(h('td', { class: 'cell-title' }, titleInput));

  const commentInput = h('textarea', { rows: 2, maxLength: 2000, value: draft.comment });
  bindDraftInput(row, id, commentInput, () => { draft.comment = commentInput.value; });
  row.append(h('td', { class: 'cell-comment' }, commentInput));

  row.append(buildTagCell(row, id, draft));

  const dateInput = h('input', { type: 'date', value: draft.publishedAt });
  bindDraftInput(row, id, dateInput, () => { draft.publishedAt = dateInput.value; });
  row.append(h('td', {}, dateInput));

  const tenureOptions = [['', '不填'], ...(state.taxonomy?.tenures || []).map(item => [item.key, item.label])];
  const tenureSelect = buildSelect(tenureOptions, draft.tenure);
  bindDraftInput(row, id, tenureSelect, () => { draft.tenure = tenureSelect.value; }, 'change');
  row.append(h('td', {}, tenureSelect));

  row.append(h('td', { class: 'cell-narrow' }, `v${Number(data.revision) || 1}`));

  row.append(h('td', { class: 'row-actions' },
    h('button', { type: 'button', class: 'ghost small', onClick: () => revertReview(id) }, '还原'),
    h('button', { type: 'button', class: 'danger small', onClick: () => deleteReview(id) }, '删除')));

  row.classList.toggle('dirty', isReviewDirty(id));
  return row;
}

function renderReviews() {
  updateTabCounts();
  const entries = visibleReviews();
  reviewRows.replaceChildren();
  if (!entries.length) {
    reviewRows.append(h('tr', {}, h('td', { class: 'empty', colSpan: 11 }, '没有匹配的评价')));
  } else {
    entries.forEach(entry => reviewRows.append(buildReviewRow(entry)));
  }
  reviewCount.textContent = `显示 ${entries.length} / 共 ${state.reviews.size} 条`;
  syncSelectAll();
  updateReviewSaveButton();
  renderBatchBar();
}

function visibleReviewIds() {
  return visibleReviews().map(entry => entry.data.id);
}

function syncSelectAll() {
  const ids = visibleReviewIds();
  const selected = ids.filter(id => state.selected.has(id)).length;
  reviewSelectAll.checked = ids.length > 0 && selected === ids.length;
  reviewSelectAll.indeterminate = selected > 0 && selected < ids.length;
}

function renderBatchBar() {
  const ids = [...state.selected].filter(id => state.reviews.has(id));
  reviewBatch.hidden = ids.length === 0;
  if (!ids.length) return;
  batchSelected.textContent = `已选 ${ids.length} 条`;

  const companyIds = new Set(ids.map(id => state.reviews.get(id)?.data.companyId));
  const singleCompany = companyIds.size === 1 ? state.companies.get([...companyIds][0]) : null;
  batchProject.disabled = !singleCompany;
  const projectOptions = singleCompany
    ? [
      ['__keep', '不修改'],
      ['__none', '不关联项目'],
      ['__anon', '匿名项目'],
      ...(singleCompany.data.projects || []).map(project => [project.id, project.name]),
    ]
    : [['__keep', '需选择同一公司的评价']];
  batchProject.replaceChildren(...projectOptions.map(([value, label]) => h('option', { value }, label)));
  batchProject.value = '__keep';
}

function updateReviewSaveButton() {
  const count = reviewDirtyIds().length;
  reviewSaveButton.textContent = `保存修改（${count}）`;
  reviewSaveButton.disabled = state.busy || count === 0;
}

function revertReview(id) {
  const entry = state.reviews.get(id);
  if (!entry) return;
  state.reviewDrafts.set(id, reviewSnapshot(entry.data));
  renderReviews();
  setStatus(globalStatus, `已还原 ${id} 的未保存修改`);
}

function applyBatch() {
  if (state.busy) return;
  const ids = [...state.selected];
  if (!ids.length) return;
  const score = batchScore.value;
  const project = batchProject.value;
  const date = batchDate.value;
  const tenure = batchTenure.value;
  const tagsMode = batchTagsMode.value;
  const pickedTags = [...batchTags.querySelectorAll('input:checked')].map(input => input.value);

  ids.forEach(id => {
    const draft = state.reviewDrafts.get(id);
    if (!draft) return;
    const next = { ...draft, tags: [...draft.tags] };
    if (score) next.score = score;
    if (project && project !== '__keep') next.project = project;
    if (date) next.publishedAt = date;
    if (tenure && tenure !== '__keep') next.tenure = tenure === '__clear' ? '' : tenure;
    if (tagsMode === 'add') next.tags = [...new Set([...next.tags, ...pickedTags])].sort();
    else if (tagsMode === 'replace') next.tags = [...new Set(pickedTags)].sort();
    else if (tagsMode === 'clear') next.tags = [];
    state.reviewDrafts.set(id, next);
  });

  renderReviews();
  setStatus(globalStatus, `已将批量修改应用到 ${ids.length} 条评价（尚未保存）`);
}

async function saveReviews() {
  if (state.busy) return;
  const ids = reviewDirtyIds();
  if (!ids.length) return;
  setBusy(true);
  let saved = 0;
  const problems = [];
  try {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      setStatus(globalStatus, `正在保存（${index + 1}/${ids.length}）：${id}…`);
      const entry = state.reviews.get(id);
      const draft = state.reviewDrafts.get(id);
      const company = state.companies.get(entry.data.companyId);
      if (!company) {
        problems.push(`${id}：所属公司不存在`);
        continue;
      }

      const projectAnonymous = draft.project === '__anon';
      const projectId = draft.project === '__none' || projectAnonymous ? '' : draft.project;
      const profile = { ...(entry.data.profile || {}) };
      if (draft.tenure) profile.tenure = draft.tenure;
      else delete profile.tenure;

      const fields = {
        score: Number(draft.score),
        title: draft.title.trim(),
        comment: draft.comment.trim(),
        projectId,
        projectAnonymous,
        tenure: draft.tenure,
        tags: [...draft.tags],
        publishedAt: draft.publishedAt,
      };

      const errors = validateDraft({
        companyId: entry.data.companyId,
        projectId,
        projectAnonymous,
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
        problems.push(`${id}：${errors.join('、')}`);
        continue;
      }

      const next = composeReview(entry.data, fields);
      if (!reviewContentChanged(entry.data, next)) {
        state.reviewDrafts.set(id, reviewSnapshot(entry.data));
        continue;
      }

      try {
        const file = await state.client.putFile(config.owner, config.publicRepo, entry.path, {
          message: `data: edit ${id}`,
          content: JSON.stringify(next, null, 2) + '\n',
          sha: entry.sha,
          branch: config.publicBranch,
        });
        entry.data = next;
        entry.sha = file?.content?.sha || entry.sha;
        state.reviewDrafts.set(id, reviewSnapshot(next));
        saved += 1;
        await logAudit('published_edit', {
          targetType: 'review',
          targetId: id,
          reviewId: id,
          companyId: entry.data.companyId,
          note: '数据表维护评价',
          commitSha: file?.commit?.sha || '',
        });
      } catch (error) {
        if (error.status === 401) throw error;
        problems.push(`${id}：${describeError(error)}`);
      }
    }

    if (problems.length) {
      const summary = problems.slice(0, 3).join('；');
      const extra = problems.length > 3 ? ` 等 ${problems.length} 项` : '';
      setStatus(globalStatus, `已保存 ${saved} 条；以下未保存：${summary}${extra}`, true);
    } else {
      setStatus(globalStatus, `已保存 ${saved} 条评价；展示站会自动重建（约 1–2 分钟）`);
    }
    renderReviews();
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

async function deleteReview(id) {
  if (state.busy) return;
  const entry = state.reviews.get(id);
  if (!entry) return;
  if (!window.confirm(`确认删除评价 ${id}？展示站会在下一次构建后移除。`)) return;
  setBusy(true);
  try {
    await state.client.deleteFile(config.owner, config.publicRepo, entry.path, {
      message: `data: delete ${id}`,
      sha: entry.sha,
      branch: config.publicBranch,
    });
    state.reviews.delete(id);
    state.reviewDrafts.delete(id);
    state.selected.delete(id);
    setStatus(globalStatus, `已删除 ${id}；展示站会自动重建（约 1–2 分钟）`);
    await logAudit('published_delete', {
      targetType: 'review',
      targetId: id,
      reviewId: id,
      companyId: entry.data.companyId,
      note: '删除评价',
    });
    renderAll();
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

// ── 公司表 ────────────────────────────────────────────────────────────────

function isCompanyDirty(id) {
  const entry = state.companies.get(id);
  const draft = state.companyDrafts.get(id);
  if (!entry || !draft) return false;
  const aliasesKey = list => parseAliases((list || []).join('，')).join('\u0000');
  return (entry.data.name || '') !== draft.name
    || (entry.data.slug || '') !== draft.slug
    || aliasesKey(entry.data.aliases || []) !== aliasesKey(parseAliases(draft.aliases));
}

function dirtyCompanyIds() {
  return [...state.companies.keys()].filter(id => isCompanyDirty(id));
}

function updateCompanySaveButton() {
  const count = dirtyCompanyIds().length;
  companySaveButton.textContent = `保存修改（${count}）`;
  companySaveButton.disabled = state.busy || count === 0;
}

function buildCompanyRow(entry) {
  const id = entry.data.id;
  const draft = state.companyDrafts.get(id);
  const row = h('tr', { dataset: { id } });
  const mark = () => {
    row.classList.toggle('dirty', isCompanyDirty(id));
    updateCompanySaveButton();
  };

  const nameInput = h('input', { type: 'text', maxLength: 50, value: draft.name, autocomplete: 'off' });
  nameInput.addEventListener('input', () => { draft.name = nameInput.value; mark(); });
  const slugInput = h('input', { type: 'text', value: draft.slug, autocomplete: 'off', spellcheck: false });
  slugInput.addEventListener('input', () => { draft.slug = slugInput.value; mark(); });
  const aliasesInput = h('input', { type: 'text', value: draft.aliases, autocomplete: 'off' });
  aliasesInput.addEventListener('input', () => { draft.aliases = aliasesInput.value; mark(); });

  row.append(
    h('td', { class: 'cell-title' }, nameInput),
    h('td', {}, h('code', { class: 'cell-id' }, id)),
    h('td', {}, slugInput),
    h('td', { class: 'cell-aliases' }, aliasesInput),
    h('td', { class: 'cell-narrow' }, String((state.projectDrafts.get(id) || entry.data.projects || []).length)),
    h('td', { class: 'cell-narrow' }, String(reviewCountForCompany(id))),
    h('td', { class: 'nowrap' }, entry.data.updatedAt || '—'),
    h('td', { class: 'row-actions' },
      h('button', {
        type: 'button',
        class: 'ghost small',
        onClick: () => { reviewCompanyFilter.value = id; showView('reviews'); },
      }, '查看评价')),
  );
  row.classList.toggle('dirty', isCompanyDirty(id));
  return row;
}

function renderCompanies() {
  updateTabCounts();
  const query = companySearch.value.trim().toLowerCase();
  const dirtyOnly = companyDirtyOnly.checked;
  const entries = sortedCompanies().filter((entry) => {
    const data = entry.data;
    if (dirtyOnly && !isCompanyDirty(data.id)) return false;
    if (!query) return true;
    const haystack = [data.name, data.id, data.slug, ...(data.aliases || [])].join(' ').toLowerCase();
    return haystack.includes(query);
  });

  companyRows.replaceChildren();
  if (!entries.length) {
    companyRows.append(h('tr', {}, h('td', { class: 'empty', colSpan: 8 }, '没有匹配的公司')));
  } else {
    entries.forEach(entry => companyRows.append(buildCompanyRow(entry)));
  }
  companyCount.textContent = `显示 ${entries.length} / 共 ${state.companies.size} 家`;
  updateCompanySaveButton();
}

async function saveCompanies() {
  if (state.busy) return;
  const ids = dirtyCompanyIds();
  if (!ids.length) return;
  setBusy(true);
  let saved = 0;
  const problems = [];
  try {
    for (let index = 0; index < ids.length; index += 1) {
      const id = ids[index];
      setStatus(globalStatus, `正在保存（${index + 1}/${ids.length}）：${id}…`);
      const entry = state.companies.get(id);
      const draft = state.companyDrafts.get(id);

      const next = composeCompany(entry.data, {
        name: draft.name.trim(),
        slug: draft.slug.trim(),
        aliases: parseAliases(draft.aliases),
        projects: entry.data.projects || [],
      });

      const errors = validateCompany(next);
      const slugTaken = [...state.companies.values()]
        .some(other => other.data.id !== id && other.data.slug === next.slug);
      if (slugTaken) errors.push(`slug「${next.slug}」已被其他公司使用`);
      if (errors.length) {
        problems.push(`${id}：${errors.join('、')}`);
        continue;
      }
      if (!companyContentChanged(entry.data, next)) {
        state.companyDrafts.set(id, {
          name: entry.data.name || '',
          slug: entry.data.slug || '',
          aliases: (entry.data.aliases || []).join('，'),
        });
        continue;
      }

      try {
        const file = await state.client.putFile(config.owner, config.publicRepo, entry.path, {
          message: `data: edit company ${id}`,
          content: JSON.stringify(next, null, 2) + '\n',
          sha: entry.sha,
          branch: config.publicBranch,
        });
        entry.data = next;
        entry.sha = file?.content?.sha || entry.sha;
        state.companyDrafts.set(id, {
          name: next.name,
          slug: next.slug,
          aliases: (next.aliases || []).join('，'),
        });
        saved += 1;
        await logAudit('published_edit', {
          targetType: 'company',
          targetId: id,
          companyId: id,
          note: '数据表维护公司信息',
          commitSha: file?.commit?.sha || '',
        });
      } catch (error) {
        if (error.status === 401) throw error;
        problems.push(`${id}：${describeError(error)}`);
      }
    }

    if (problems.length) {
      const summary = problems.slice(0, 3).join('；');
      const extra = problems.length > 3 ? ` 等 ${problems.length} 项` : '';
      setStatus(globalStatus, `已保存 ${saved} 家；以下未保存：${summary}${extra}`, true);
    } else {
      setStatus(globalStatus, `已保存 ${saved} 家公司信息；展示站会自动重建（约 1–2 分钟）`);
    }
    refreshCompanySelects();
    renderAll();
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
}

// ── 项目表 ────────────────────────────────────────────────────────────────

function isProjectRowDirty(companyId, project) {
  const entry = state.companies.get(companyId);
  const original = (entry?.data.projects || []).find(item => item.id === project.id);
  return !original || original.name !== project.name || original.status !== project.status;
}

function dirtyProjectCompanyIds() {
  return [...state.projectDrafts.entries()]
    .filter(([companyId, rows]) => {
      const entry = state.companies.get(companyId);
      if (!entry) return false;
      return projectSnapshotKey(rows) !== projectSnapshotKey(projectSnapshot(entry.data.projects));
    })
    .map(([companyId]) => companyId);
}

function updateProjectSaveButton() {
  const count = dirtyProjectCompanyIds().length;
  projectSaveButton.textContent = `保存修改（${count} 家）`;
  projectSaveButton.disabled = state.busy || count === 0;
}

function markProjectRow(row, companyId, project) {
  row.classList.toggle('dirty', isProjectRowDirty(companyId, project));
  updateProjectSaveButton();
}

function buildProjectRow(companyId, companyName, project) {
  const row = h('tr', { dataset: { company: companyId, project: project.id } });
  const nameInput = h('input', { type: 'text', maxLength: 50, value: project.name, autocomplete: 'off' });
  nameInput.addEventListener('input', () => {
    project.name = nameInput.value;
    markProjectRow(row, companyId, project);
  });
  const statusSelect = buildSelect(PROJECT_STATUSES, project.status);
  statusSelect.addEventListener('change', () => {
    project.status = statusSelect.value;
    markProjectRow(row, companyId, project);
  });

  const count = reviewCountForProject(companyId, project.id);
  const removeButton = h('button', {
    type: 'button',
    class: 'danger small',
    onClick: () => deleteProject(companyId, project.id),
  }, '删除');
  if (count > 0) {
    removeButton.disabled = true;
    removeButton.title = '该项目下已有展示评价，不能删除';
  }

  row.append(
    h('td', { class: 'cell-company' }, h('strong', {}, companyName)),
    h('td', { class: 'cell-title' }, nameInput),
    h('td', {}, h('code', { class: 'cell-id' }, project.id)),
    h('td', {}, statusSelect),
    h('td', { class: 'cell-narrow' }, String(count)),
    h('td', { class: 'row-actions' }, removeButton),
  );
  row.classList.toggle('dirty', isProjectRowDirty(companyId, project));
  return row;
}

function renderProjects() {
  updateTabCounts();
  const query = projectSearch.value.trim().toLowerCase();
  const companyId = projectCompanyFilter.value;
  const rows = [];
  state.projectDrafts.forEach((projects, ownerId) => {
    const entry = state.companies.get(ownerId);
    if (!entry) return;
    if (companyId && ownerId !== companyId) return;
    projects.forEach(project => {
      const haystack = [entry.data.name, entry.data.id, project.name, project.id].join(' ').toLowerCase();
      if (query && !haystack.includes(query)) return;
      rows.push({ ownerId, companyName: entry.data.name, project });
    });
  });
  rows.sort((a, b) => a.companyName.localeCompare(b.companyName, 'zh-CN')
    || a.project.name.localeCompare(b.project.name, 'zh-CN'));

  projectRows.replaceChildren();
  if (!rows.length) {
    projectRows.append(h('tr', {}, h('td', { class: 'empty', colSpan: 6 }, '没有匹配的项目')));
  } else {
    rows.forEach(row => projectRows.append(buildProjectRow(row.ownerId, row.companyName, row.project)));
  }
  let total = 0;
  state.projectDrafts.forEach(projects => { total += projects.length; });
  projectCount.textContent = `显示 ${rows.length} / 共 ${total} 个项目`;
  updateProjectSaveButton();
}

function openNewProjectForm() {
  projectNewForm.hidden = false;
  fillCompanySelect(newProjectCompany);
  if (projectCompanyFilter.value) newProjectCompany.value = projectCompanyFilter.value;
  newProjectName.value = '';
  newProjectStatus.value = 'live';
  newProjectName.focus();
}

function addProject() {
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
  const projects = state.projectDrafts.get(companyId) || [];
  const id = newProjectId(name, new Set(projects.map(project => project.id)));
  projects.push({ id, name, status: newProjectStatus.value });
  state.projectDrafts.set(companyId, projects);
  projectNewForm.hidden = true;
  renderProjects();
  setStatus(globalStatus, `已添加项目「${name}」（尚未保存）`);
}

function deleteProject(companyId, projectId) {
  if (state.busy) return;
  const count = reviewCountForProject(companyId, projectId);
  if (count > 0) {
    setStatus(globalStatus, '该项目下已有展示评价，不能删除', true);
    return;
  }
  const projects = state.projectDrafts.get(companyId) || [];
  const target = projects.find(project => project.id === projectId);
  if (!target) return;
  if (!window.confirm(`确认移除项目「${target.name}」？保存后生效。`)) return;
  state.projectDrafts.set(companyId, projects.filter(project => project.id !== projectId));
  renderProjects();
  setStatus(globalStatus, `已移除项目「${target.name}」（尚未保存）`);
}

async function saveProjects() {
  if (state.busy) return;
  const ids = dirtyProjectCompanyIds();
  if (!ids.length) return;
  setBusy(true);
  let saved = 0;
  const problems = [];
  try {
    for (let index = 0; index < ids.length; index += 1) {
      const companyId = ids[index];
      setStatus(globalStatus, `正在保存（${index + 1}/${ids.length}）：${companyId}…`);
      const entry = state.companies.get(companyId);
      const rows = state.projectDrafts.get(companyId) || [];
      const projects = composeProjects(entry.data.projects || [], rows);

      const next = composeCompany(entry.data, {
        name: entry.data.name,
        slug: entry.data.slug,
        aliases: entry.data.aliases || [],
        projects,
      });

      const errors = validateCompany(next);
      const seen = new Set();
      next.projects.forEach(project => {
        if (seen.has(project.id)) errors.push(`项目 ID 重复：${project.id}`);
        seen.add(project.id);
      });
      const referenced = referencedProjectIds([...state.reviews.values()]
        .filter(review => review.data.companyId === companyId)
        .map(review => review.data));
      (entry.data.projects || []).forEach(project => {
        if (!projects.some(item => item.id === project.id) && referenced.has(project.id)) {
          errors.push(`项目「${project.name}」下已有展示评价，不能删除`);
        }
      });
      if (errors.length) {
        problems.push(`${companyId}：${errors.join('、')}`);
        continue;
      }
      if (!companyContentChanged(entry.data, next)) {
        state.projectDrafts.set(companyId, projectSnapshot(entry.data.projects));
        continue;
      }

      try {
        const file = await state.client.putFile(config.owner, config.publicRepo, entry.path, {
          message: `data: edit company ${companyId}`,
          content: JSON.stringify(next, null, 2) + '\n',
          sha: entry.sha,
          branch: config.publicBranch,
        });
        entry.data = next;
        entry.sha = file?.content?.sha || entry.sha;
        state.projectDrafts.set(companyId, projectSnapshot(next.projects));
        saved += 1;
        await logAudit('published_edit', {
          targetType: 'company',
          targetId: companyId,
          companyId,
          note: '数据表维护项目列表',
          commitSha: file?.commit?.sha || '',
        });
      } catch (error) {
        if (error.status === 401) throw error;
        problems.push(`${companyId}：${describeError(error)}`);
      }
    }

    if (problems.length) {
      const summary = problems.slice(0, 3).join('；');
      const extra = problems.length > 3 ? ` 等 ${problems.length} 项` : '';
      setStatus(globalStatus, `已保存 ${saved} 家；以下未保存：${summary}${extra}`, true);
    } else {
      setStatus(globalStatus, `已保存 ${saved} 家公司的项目信息；展示站会自动重建（约 1–2 分钟）`);
    }
    renderAll();
  } catch (error) {
    handleError(error);
  } finally {
    setBusy(false);
  }
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

  state.reviewDrafts = new Map([...state.reviews].map(([id, entry]) => [id, reviewSnapshot(entry.data)]));
  state.companyDrafts = new Map([...state.companies].map(([id, entry]) => [id, {
    name: entry.data.name || '',
    slug: entry.data.slug || '',
    aliases: (entry.data.aliases || []).join('，'),
  }]));
  state.projectDrafts = new Map([...state.companies].map(([id, entry]) => [id, projectSnapshot(entry.data.projects)]));
  state.selected.clear();

  renderBatchTags();
}

function renderBatchTags() {
  batchTags.replaceChildren(...(state.taxonomy?.tags || []).map(tag =>
    h('label', {}, h('input', { type: 'checkbox', value: tag.key }), tag.label)));
  batchTagsMode.value = '__keep';
  batchTags.hidden = true;
  batchTenure.replaceChildren(
    h('option', { value: '__keep' }, '不修改'),
    h('option', { value: '__clear' }, '清空'),
    ...(state.taxonomy?.tenures || []).map(tag => h('option', { value: tag.key }, tag.label)),
  );
  batchTenure.value = '__keep';
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
  state.reviewDrafts = new Map();
  state.companyDrafts = new Map();
  state.projectDrafts = new Map();
  state.selected.clear();
  state.busy = false;
  userLabel.textContent = '';
  reviewRows.replaceChildren();
  companyRows.replaceChildren();
  projectRows.replaceChildren();
  reviewCount.textContent = '';
  companyCount.textContent = '';
  projectCount.textContent = '';
  reviewBatch.hidden = true;
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

const resetReviewView = () => {
  state.selected.clear();
  renderReviews();
};
reviewSearch.addEventListener('input', resetReviewView);
reviewCompanyFilter.addEventListener('change', resetReviewView);
reviewScoreFilter.addEventListener('change', resetReviewView);
reviewDirtyOnly.addEventListener('change', resetReviewView);
reviewSaveButton.addEventListener('click', saveReviews);
reviewRefresh.addEventListener('click', refreshData);

reviewSelectAll.addEventListener('change', () => {
  const ids = visibleReviewIds();
  if (reviewSelectAll.checked) ids.forEach(id => state.selected.add(id));
  else ids.forEach(id => state.selected.delete(id));
  renderReviews();
});

batchTagsMode.addEventListener('change', () => {
  batchTags.hidden = !['add', 'replace'].includes(batchTagsMode.value);
});
batchApply.addEventListener('click', applyBatch);
batchClear.addEventListener('click', () => {
  state.selected.clear();
  renderReviews();
});

companySearch.addEventListener('input', renderCompanies);
companyDirtyOnly.addEventListener('change', renderCompanies);
companySaveButton.addEventListener('click', saveCompanies);
companyRefresh.addEventListener('click', refreshData);

projectSearch.addEventListener('input', renderProjects);
projectCompanyFilter.addEventListener('change', renderProjects);
projectNewButton.addEventListener('click', () => {
  if (projectNewForm.hidden) openNewProjectForm();
  else projectNewForm.hidden = true;
});
projectSaveButton.addEventListener('click', saveProjects);
projectRefresh.addEventListener('click', refreshData);
newProjectAdd.addEventListener('click', addProject);
newProjectCancel.addEventListener('click', () => { projectNewForm.hidden = true; });
newProjectName.addEventListener('keydown', event => {
  if (event.key === 'Enter') {
    event.preventDefault();
    addProject();
  }
});

window.addEventListener('beforeunload', event => {
  if (!hasDirty()) return;
  event.preventDefault();
  event.returnValue = '';
});

const savedToken = getToken();
if (savedToken) signIn(savedToken, { silent: true });
else {
  clearSession();
  showLogin();
}
