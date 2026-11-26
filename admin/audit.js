import { createApi, ApiError } from './lib/api.js';
import { getToken, setToken, clearToken } from './lib/token.js';
import { getSession, setSession, clearSession } from './lib/session.js';
import { config } from './config.js';
import { h } from './lib/dom.js';

const PAGE = 50;

const ACTION_OPTIONS = [
  ['', '全部动作'],
  ['approve', '通过发布'],
  ['reject', '拒绝'],
  ['delete', '删除评价'],
  ['correct', '更正评价'],
  ['request_rejected', '驳回申请'],
  ['contact_handled', '联系已处理'],
  ['published_edit', '修正已展示'],
  ['published_delete', '删除已展示'],
  ['deploy_showcase', '更新展示站'],
  ['login_success', '登录成功'],
  ['login_denied', '登录失败'],
  ['auth_denied', '无权限访问'],
];
const ACTION_LABEL = Object.fromEntries(ACTION_OPTIONS.filter(([key]) => key));
const RESULT_LABEL = { success: '成功', denied: '拒绝', failed: '失败' };
const TARGET_LABEL = {
  submission: '提交',
  review: '评价',
  request: '申请',
  contact: '联系消息',
  session: '登录',
  deploy: '部署',
};

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
const actionSelect = $('#filter-action');
const reviewerInput = $('#filter-reviewer');
const fromInput = $('#filter-from');
const toInput = $('#filter-to');
const searchButton = $('#search-button');
const resetButton = $('#reset-button');
const countLabel = $('#audit-count');
const rowsBody = $('#audit-rows');
const prevButton = $('#prev-button');
const nextButton = $('#next-button');
const pageInfo = $('#page-info');
const globalStatus = $('#global-status');

const state = {
  api: null,
  login: '',
  offset: 0,
  total: 0,
  items: [],
};

ACTION_OPTIONS.forEach(([value, label]) => {
  actionSelect.append(h('option', { value }, label));
});

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
  if (error instanceof TypeError) return '无法连接审核 API，请确认网络。';
  if (error instanceof ApiError || error.status) {
    if (error.status === 401) return 'token 已失效，请重新登录。';
    if (error.status === 403) return error.message || '没有仓库写权限。';
    return error.message || `HTTP ${error.status}`;
  }
  return error.message || '操作失败';
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value || '—';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function objectText(item) {
  const label = TARGET_LABEL[item.targetType] || item.targetType || '';
  const id = item.targetId || item.reviewId || item.companyId || '';
  return [label, id].filter(Boolean).join(' ') || '—';
}

function commitCell(item) {
  const sha = item.details && item.details.commitSha;
  if (!sha) return '—';
  return h('a', {
    href: `https://github.com/${config.owner}/${config.publicRepo}/commit/${sha}`,
    target: '_blank',
    rel: 'noreferrer',
    title: sha,
  }, sha.slice(0, 7));
}

function renderRows() {
  rowsBody.replaceChildren();
  if (!state.items.length) {
    rowsBody.append(h('tr', {}, h('td', { colspan: 7, class: 'empty' }, '暂无审计记录')));
    return;
  }
  state.items.forEach(item => {
    rowsBody.append(h('tr', {},
      h('td', { class: 'nowrap' }, formatTime(item.at)),
      h('td', {}, item.reviewer ? `@${item.reviewer}` : '—'),
      h('td', {}, ACTION_LABEL[item.action] || item.action),
      h('td', {}, objectText(item)),
      h('td', {}, h('span', { class: `badge result-${item.result}` }, RESULT_LABEL[item.result] || item.result)),
      h('td', { class: 'nowrap' }, commitCell(item)),
      h('td', { class: 'reason' }, item.reason || '—'),
    ));
  });
}

function renderPager() {
  const pages = Math.max(1, Math.ceil(state.total / PAGE));
  const page = Math.floor(state.offset / PAGE) + 1;
  pageInfo.textContent = `第 ${page} / ${pages} 页 · 共 ${state.total} 条`;
  countLabel.textContent = `${state.total} 条`;
  prevButton.disabled = state.offset <= 0;
  nextButton.disabled = state.offset + PAGE >= state.total;
}

async function load() {
  if (!state.api) return;
  setStatus(globalStatus, '正在加载…');
  const params = { limit: PAGE, offset: state.offset };
  if (actionSelect.value) params.action = actionSelect.value;
  if (reviewerInput.value.trim()) params.reviewer = reviewerInput.value.trim();
  if (fromInput.value) params.from = new Date(`${fromInput.value}T00:00:00`).toISOString();
  if (toInput.value) params.to = new Date(`${toInput.value}T23:59:59.999`).toISOString();

  try {
    const data = await state.api.listAudit(params);
    state.items = data.items || [];
    state.total = data.total || 0;
    renderRows();
    renderPager();
    setStatus(globalStatus, '');
  } catch (error) {
    if (error.status === 401) {
      signOut('登录已失效，请重新登录。');
      return;
    }
    setStatus(globalStatus, describeError(error), true);
  }
}

async function signIn(token, { silent = false } = {}) {
  if (!token) {
    clearSession();
    showLogin();
    return;
  }
  const cached = silent ? getSession() : null;
  let authenticated = Boolean(cached);
  showBoot(cached
    ? '正在加载审计日志…'
    : (silent ? '正在验证登录状态，无需重新输入 token…' : '正在登录…'));
  try {
    const api = createApi(token);
    let login = cached?.login || '';
    if (!cached) {
      const me = await api.me();
      login = me.login;
      authenticated = true;
      setSession(login);
    }
    setToken(token);
    state.api = api;
    state.login = login;
    userLabel.textContent = login ? `@${login}` : '';
    showBoot('登录有效，正在加载审计日志…');
    await load();
    showApp();
    setStatus(loginStatus, '');
  } catch (error) {
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
  state.api = null;
  state.items = [];
  state.offset = 0;
  userLabel.textContent = '';
  rowsBody.replaceChildren();
  countLabel.textContent = '';
  pageInfo.textContent = '';
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
  clearSession();
  showLogin();
  tokenInput.focus();
});
searchButton.addEventListener('click', () => {
  state.offset = 0;
  load();
});
resetButton.addEventListener('click', () => {
  actionSelect.value = '';
  reviewerInput.value = '';
  fromInput.value = '';
  toInput.value = '';
  state.offset = 0;
  load();
});
prevButton.addEventListener('click', () => {
  state.offset = Math.max(0, state.offset - PAGE);
  load();
});
nextButton.addEventListener('click', () => {
  state.offset += PAGE;
  load();
});

const saved = getToken();
if (saved) signIn(saved, { silent: true });
else {
  clearSession();
  showLogin();
}
