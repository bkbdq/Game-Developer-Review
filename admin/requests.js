import { createApi, ApiError } from './lib/api.js';
import { createClient } from './lib/github.js';
import { config } from './config.js';
import { h } from './lib/dom.js';

const TOKEN_KEY = 'gdr.admin.token';
const TYPE_LABEL = { deletion: '删除', correction: '更正' };
const STATUS_LABEL = { received: '已收到', processed: '已处理', rejected: '已驳回', handled: '已处理' };

const $ = selector => document.querySelector(selector);
const loginView = $('#login-view');
const loginForm = $('#login-form');
const tokenInput = $('#token');
const loginStatus = $('#login-status');
const appView = $('#app-view');
const logoutButton = $('#logout-button');
const userLabel = $('#user-label');
const tabRequests = $('#tab-requests');
const tabContacts = $('#tab-contacts');
const refreshButton = $('#refresh-button');
const queueCount = $('#queue-count');
const queueList = $('#queue-list');
const queueDetail = $('#queue-detail');
const globalStatus = $('#global-status');

const state = {
  api: null,
  client: null,
  login: '',
  tab: 'requests',
  items: [],
  selected: null,
  busy: false,
};

const initialTab = new URLSearchParams(location.search).get('tab') === 'contacts' ? 'contacts' : 'requests';
state.tab = initialTab;
tabRequests.classList.toggle('active', initialTab === 'requests');
tabContacts.classList.toggle('active', initialTab === 'contacts');

function setStatus(element, message, isError = false) {
  element.textContent = message || '';
  element.classList.toggle('error', Boolean(isError));
}

function describeError(error) {
  if (error instanceof TypeError) return '无法连接审核 API，请确认网络或本地控制台仍在运行。';
  if (error instanceof ApiError || error.status) {
    if (error.status === 401) return 'token 已失效，请重新登录。';
    if (error.status === 403) return error.message || '没有仓库写权限。';
    return error.message || `HTTP ${error.status}`;
  }
  return error.message || '操作失败';
}

function setBusy(busy) {
  state.busy = busy;
  refreshButton.disabled = busy;
}

function setTab(tab) {
  if (state.tab === tab) return;
  state.tab = tab;
  state.selected = null;
  state.items = [];
  tabRequests.classList.toggle('active', tab === 'requests');
  tabContacts.classList.toggle('active', tab === 'contacts');
  queueDetail.replaceChildren(h('div', { class: 'empty' }, '选择左侧一条记录'));
  loadItems().catch(handleError);
}

function renderList() {
  queueList.replaceChildren();
  if (!state.items.length) {
    queueList.append(h('p', { class: 'empty' }, state.tab === 'requests' ? '暂无待处理申请' : '暂无待处理消息'));
  }
  state.items.forEach(item => {
    const title = state.tab === 'requests'
      ? `${TYPE_LABEL[item.type] || item.type} · ${item.receipt.slice(0, 8)}…`
      : (item.contact || '未留联系方式');
    queueList.append(h('button', {
      type: 'button',
      class: 'item' + (state.selected?.id === item.id ? ' active' : ''),
      onClick: () => selectItem(item),
    },
      h('div', { class: 'item-head' }, h('strong', {}, title), h('span', {}, (item.createdAt || '').slice(0, 10))),
      h('div', { class: 'item-meta' }, (item.message || '').slice(0, 42)),
    ));
  });
  queueCount.textContent = `共 ${state.items.length} 条`;
}

function field(label, value) {
  return h('p', { class: 'queue-field' }, h('strong', {}, label + '：'), value || '—');
}

function actionButton(label, onClick, className = '') {
  return h('button', { type: 'button', class: className, onClick }, label);
}

function selectItem(item) {
  state.selected = item;
  renderList();
  renderDetail(item);
}

function renderDetail(item) {
  if (state.tab === 'contacts') return renderContact(item);
  return renderRequest(item);
}

function renderRequest(item) {
  const actions = [];
  if (item.type === 'deletion') {
    actions.push(actionButton('删除公开评价并处理', () => handleDeletion(item)));
  } else {
    actions.push(actionButton('加载并更正正文', () => startCorrection(item)));
  }
  actions.push(actionButton('驳回申请', () => rejectRequest(item), 'danger'));

  queueDetail.replaceChildren(
    h('h2', {}, `${TYPE_LABEL[item.type] || item.type}申请`),
    field('状态', STATUS_LABEL[item.status] || item.status),
    field('回执编号', item.receipt),
    field('评价 ID', item.reviewId),
    field('公司 ID', item.companyId),
    field('提交时间', (item.createdAt || '').slice(0, 19).replace('T', ' ')),
    field('申请原因', item.message),
    h('div', { class: 'actions' }, ...actions),
    h('p', { class: 'status', id: 'detail-status', role: 'status' }),
  );
}

function renderContact(item) {
  queueDetail.replaceChildren(
    h('h2', {}, '联系消息'),
    field('状态', STATUS_LABEL[item.status] || item.status),
    field('提交时间', (item.createdAt || '').slice(0, 19).replace('T', ' ')),
    field('联系方式', item.contact),
    field('内容', item.message),
    h('div', { class: 'actions' }, actionButton('标记已处理', () => handleContact(item))),
    h('p', { class: 'status', id: 'detail-status', role: 'status' }),
  );
}

function detailStatus() {
  return queueDetail.querySelector('#detail-status');
}

async function resolveReview(item) {
  if (!item.reviewId) throw new Error('该申请没有关联评价 ID');
  if (item.companyId) {
    const path = `${config.reviewsDir}/${item.companyId}/${item.reviewId}.json`;
    const file = await state.client.getFile(config.owner, config.publicRepo, path, config.publicBranch);
    if (file) return { path, file, companyId: item.companyId };
  }
  const tree = await state.client.getTree(config.owner, config.publicRepo, config.publicBranch);
  const found = (tree.tree || []).find(entry =>
    entry.type === 'blob' &&
    entry.path.startsWith(`${config.reviewsDir}/`) &&
    entry.path.endsWith(`/${item.reviewId}.json`));
  if (!found) throw new Error('公开仓中找不到该评价文件');
  const companyId = found.path.split('/')[2];
  const file = await state.client.getFile(config.owner, config.publicRepo, found.path, config.publicBranch);
  if (!file) throw new Error('无法读取评价文件');
  return { path: found.path, file, companyId };
}

async function handleDeletion(item) {
  if (state.busy) return;
  if (!window.confirm('确认从公开仓删除这条评价？此操作会立即影响展示站。')) return;
  setBusy(true);
  setStatus(detailStatus(), '正在删除公开评价…');
  try {
    const target = await resolveReview(item);
    try {
      await state.client.deleteFile(config.owner, config.publicRepo, target.path, {
        message: `data: delete ${item.reviewId}`,
        sha: target.file.sha,
        branch: config.publicBranch,
      });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    await state.api.processRequest(item.id, {
      action: 'process',
      note: '已删除公开评价',
      reviewId: item.reviewId,
      companyId: target.companyId,
    });
    setStatus(globalStatus, `已删除并处理：${item.reviewId}`);
    await loadItems();
  } catch (error) {
    setStatus(detailStatus(), describeError(error), true);
  } finally {
    setBusy(false);
  }
}

async function startCorrection(item) {
  if (state.busy) return;
  setBusy(true);
  setStatus(detailStatus(), '正在读取公开评价…');
  try {
    const target = await resolveReview(item);
    const review = JSON.parse(target.file.content);
    const textarea = h('textarea', { rows: 8, maxlength: 2000 });
    textarea.value = review.comment || '';
    queueDetail.replaceChildren(
      h('h2', {}, '更正正文'),
      field('回执编号', item.receipt),
      field('评价 ID', item.reviewId),
      h('label', {}, '正文', textarea),
      h('div', { class: 'actions' },
        actionButton('保存更正并处理', async () => {
          const comment = textarea.value.trim();
          if (!comment) { setStatus(detailStatus(), '正文不能为空', true); return; }
          setBusy(true);
          setStatus(detailStatus(), '正在提交更正…');
          try {
            const next = { ...review, comment, revision: Number(review.revision || 1) + 1 };
            await state.client.putFile(config.owner, config.publicRepo, target.path, {
              message: `data: correct ${item.reviewId}`,
              content: JSON.stringify(next, null, 2) + '\n',
              sha: target.file.sha,
              branch: config.publicBranch,
            });
            await state.api.processRequest(item.id, {
              action: 'process',
              note: '已更正公开评价正文',
              reviewId: item.reviewId,
              companyId: target.companyId,
            });
            setStatus(globalStatus, `已更正并处理：${item.reviewId}`);
            await loadItems();
          } catch (error) {
            setStatus(detailStatus(), describeError(error), true);
          } finally {
            setBusy(false);
          }
        }),
        actionButton('取消', () => renderRequest(item), 'ghost'),
      ),
      h('p', { class: 'status', id: 'detail-status', role: 'status' }),
    );
  } catch (error) {
    setStatus(detailStatus(), describeError(error), true);
  } finally {
    setBusy(false);
  }
}

async function rejectRequest(item) {
  if (state.busy) return;
  const note = window.prompt('填写驳回说明（必填）');
  if (note === null) return;
  if (!note.trim()) { setStatus(detailStatus(), '驳回说明不能为空', true); return; }
  setBusy(true);
  setStatus(detailStatus(), '正在驳回…');
  try {
    await state.api.processRequest(item.id, { action: 'reject', note: note.trim() });
    setStatus(globalStatus, `已驳回：${item.receipt.slice(0, 8)}…`);
    await loadItems();
  } catch (error) {
    setStatus(detailStatus(), describeError(error), true);
  } finally {
    setBusy(false);
  }
}

async function handleContact(item) {
  if (state.busy) return;
  const note = window.prompt('处理备注（选填）', '');
  if (note === null) return;
  setBusy(true);
  setStatus(detailStatus(), '正在标记…');
  try {
    await state.api.handleContact(item.id, { note: note.trim() });
    setStatus(globalStatus, '已标记为处理');
    await loadItems();
  } catch (error) {
    setStatus(detailStatus(), describeError(error), true);
  } finally {
    setBusy(false);
  }
}

async function loadItems() {
  if (!state.api) return;
  setStatus(globalStatus, '正在加载…');
  state.selected = null;
  queueDetail.replaceChildren(h('div', { class: 'empty' }, '选择左侧一条记录'));
  state.items = state.tab === 'requests'
    ? (await state.api.listRequests('received')).items || []
    : (await state.api.listContacts('received')).items || [];
  renderList();
  setStatus(globalStatus, '');
}

function handleError(error) {
  if (error.status === 401) {
    signOut('登录已失效，请重新登录。');
    return;
  }
  setStatus(globalStatus, describeError(error), true);
}

async function signIn(token, { silent = false } = {}) {
  if (!silent) setStatus(loginStatus, '正在验证 token…');
  try {
    const api = createApi(token);
    const me = await api.me();
    sessionStorage.setItem(TOKEN_KEY, token);
    state.api = api;
    state.client = createClient(token);
    state.login = me.login;
    userLabel.textContent = `@${me.login}`;
    loginView.hidden = true;
    appView.hidden = false;
    logoutButton.hidden = false;
    setStatus(loginStatus, '');
    await loadItems();
  } catch (error) {
    sessionStorage.removeItem(TOKEN_KEY);
    state.api = null;
    state.client = null;
    setStatus(loginStatus, describeError(error), true);
  }
}

function signOut(message = '') {
  sessionStorage.removeItem(TOKEN_KEY);
  state.api = null;
  state.client = null;
  state.items = [];
  state.selected = null;
  loginView.hidden = false;
  appView.hidden = true;
  logoutButton.hidden = true;
  userLabel.textContent = '';
  queueList.replaceChildren();
  queueCount.textContent = '';
  queueDetail.replaceChildren(h('div', { class: 'empty' }, '选择左侧一条记录'));
  setStatus(loginStatus, message, Boolean(message));
  setStatus(globalStatus, '');
}

loginForm.addEventListener('submit', event => {
  event.preventDefault();
  signIn(tokenInput.value.trim());
});
logoutButton.addEventListener('click', () => signOut());
tabRequests.addEventListener('click', () => setTab('requests'));
tabContacts.addEventListener('click', () => setTab('contacts'));
refreshButton.addEventListener('click', () => loadItems().catch(handleError));

const saved = sessionStorage.getItem(TOKEN_KEY);
if (saved) signIn(saved, { silent: true });
