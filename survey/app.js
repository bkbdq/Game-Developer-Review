const form = document.querySelector('#submit-form');
const statusEl = document.querySelector('#status');
const submitButton = document.querySelector('#submit-button');
const cancelButton = document.querySelector('#cancel-button');
const successPanel = document.querySelector('#success-panel');
const receiptEl = document.querySelector('#receipt');
const againButton = document.querySelector('#again-button');
const fallbackPanel = document.querySelector('#fallback-panel');
const fallbackStatus = document.querySelector('#fallback-status');
const copyButton = document.querySelector('#copy-button');
const retryButton = document.querySelector('#retry-button');
const deleteButton = document.querySelector('#delete-button');
const companyReturn = document.querySelector('#company-return');
const siteBase = new URL('../', companyReturn.href);
if (document.referrer && ['127.0.0.1','localhost'].includes(location.hostname)) {
  const source = new URL(document.referrer);
  if (source.hostname === location.hostname) siteBase.href = source.origin + '/';
}
document.querySelectorAll('[data-site-path]').forEach(link => {
  link.href = new URL(link.dataset.sitePath, siteBase).href;
});
const draftNote = document.querySelector('#draft-note');
const companyList = document.querySelector('#company-options');

const FIELDS = ['company', 'companyId', 'project', 'score', 'tenure', 'comment'];
const query = new URLSearchParams(location.search);
const entryCompany = (query.get('company') || '').trim().slice(0, 50);
const entryProject = (query.get('project') || '').trim().slice(0, 50);
const anonymousProject = form.elements.namedItem('anonymousProject');
const DRAFT_KEY = 'gdr.submission.draft.v1';
const DRAFT_TTL = 7 * 24 * 60 * 60 * 1000;
const COMPANY_CATALOG_KEY = 'gdr.company.catalog.v1';
const COMPANY_CATALOG_URL = '/api/companies';
const COMPANY_CATALOG_TTL = 7 * 24 * 60 * 60 * 1000;
const POW_DIFFICULTY = 3;
const REQUEST_TIMEOUT = 5000;
const GLOBAL_TIMEOUT = 15000;

let busy = false;
let controller = null;
let deadline = 0;
let slowTimer = null;
let startedAt = Date.now();
let saveTimer = null;
let companyIndex = new Map();
const companySlugs = new Map();

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle('error', isError);
}

function setFallbackStatus(message, isError = false) {
  fallbackStatus.textContent = message;
  fallbackStatus.classList.toggle('error', isError);
}

function setBusy(state) {
  busy = state;
  submitButton.disabled = state;
  submitButton.textContent = state ? '提交中…' : '提交';
  if (!state) cancelButton.hidden = true;
}

function randomHex(bytes = 16) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))]
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function solvePow() {
  const challenge = randomHex(16);
  const prefix = '0'.repeat(POW_DIFFICULTY);
  let nonce = 0;
  while (true) {
    if ((await sha256Hex(`${challenge}:${nonce}`)).startsWith(prefix)) {
      return { challenge, nonce: String(nonce) };
    }
    nonce += 1;
    if (nonce % 500 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
}

function readCachedCatalog() {
  try {
    const cached = JSON.parse(localStorage.getItem(COMPANY_CATALOG_KEY) || 'null');
    if (cached && Array.isArray(cached.companies) && Date.now() - cached.savedAt < COMPANY_CATALOG_TTL) {
      return cached.companies;
    }
  } catch {
    // 缓存损坏时忽略
  }
  return null;
}

function saveCatalog(companies) {
  try {
    localStorage.setItem(COMPANY_CATALOG_KEY, JSON.stringify({ savedAt: Date.now(), companies }));
  } catch {
    // 本地存储不可用时忽略
  }
}

function syncCompanyId() {
  const input = form.elements.namedItem('company');
  const hidden = form.elements.namedItem('companyId');
  if (!input || !hidden) return;
  hidden.value = companyIndex.get(input.value.trim().toLowerCase()) || '';
}

function renderCatalog(companies) {
  const seen = new Set();
  const options = [];
  companyIndex = new Map();
  companies
    .filter(company => company && company.id && company.name)
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    .forEach(company => {
      if (company.slug) companySlugs.set(company.id, company.slug);
      [company.name, ...(company.aliases || [])].forEach(label => {
        const text = String(label || '').trim();
        if (!text || seen.has(text.toLowerCase())) return;
        seen.add(text.toLowerCase());
        if (label === company.name) options.push(new Option(text, text));
        companyIndex.set(text.toLowerCase(), company.id);
      });
      if (company.slug) companyIndex.set(String(company.slug).toLowerCase(), company.id);
    });
  companyList.replaceChildren(...options);
  syncCompanyId();
}

async function loadCompanyCatalog() {
  const cached = readCachedCatalog();
  if (cached) {
    renderCatalog(cached);
    return;
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 3000);
  try {
    const response = await fetch(COMPANY_CATALOG_URL, {
      signal: abort.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return;
    const data = await response.json();
    const companies = Array.isArray(data?.companies)
      ? data.companies.map(company => ({
        id: company.id,
        name: company.name,
        slug: company.slug,
        aliases: Array.isArray(company.aliases) ? company.aliases : [],
      }))
      : [];
    if (!companies.length) return;
    renderCatalog(companies);
    saveCatalog(companies);
  } catch {
    // 拉不到公司列表时保持自由输入，不影响提交
  } finally {
    clearTimeout(timer);
  }
}

function readFields() {
  const values = {};
  FIELDS.forEach(name => { values[name] = form.elements.namedItem(name)?.value ?? ''; });
  values.website = form.elements.namedItem('website')?.value ?? '';
  values.consent = form.elements.namedItem('consent')?.checked ?? false;
  if (anonymousProject.checked) delete values.project;
  return values;
}

function updateSubject() {
  const company = form.elements.namedItem('company').value.trim();
  const project = form.elements.namedItem('project').value.trim();
  const subject = document.querySelector('#survey-subject');
  document.querySelector('#anonymous-project-option').hidden = !project;
  if (!project) anonymousProject.checked = false;
  subject.textContent = '正在评价：' + [company, anonymousProject.checked ? '匿名项目' : project].filter(Boolean).join(' · ');
  subject.hidden = !company && !project;
}

function fillFields(values) {
  FIELDS.forEach(name => {
    const field = form.elements.namedItem(name);
    if (field && typeof values[name] === 'string') field.value = values[name];
  });
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      savedAt: Date.now(),
      submissionId: document.querySelector('#submissionId').value,
      values: readFields(),
      entryCompany, entryProject,
      anonymousProject: anonymousProject.checked,
    }));
  } catch {
    // 本地存储不可用时静默跳过
  }
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveDraft, 300);
}

function restoreDraft() {
  let draft = null;
  try {
    draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
  } catch {
    return;
  }
  if (!draft || !draft.savedAt || Date.now() - draft.savedAt > DRAFT_TTL) {
    localStorage.removeItem(DRAFT_KEY);
    return;
  }
  const values = draft.values || {};
  // A link to another company or project must never inherit the previous review's text or receipt.
  if (entryCompany || entryProject) {
    if ((draft.entryCompany ?? values.company) !== entryCompany || (draft.entryProject ?? values.project ?? '') !== entryProject) return;
  }
  fillFields(values);
  anonymousProject.checked = Boolean(draft.anonymousProject);
  if (draft.submissionId) document.querySelector('#submissionId').value = draft.submissionId;
  draftNote.hidden = false;
  startedAt = Date.now();
}

function buildText() {
  const values = readFields();
  return [
    `公司：${values.company}`,
    values.project ? `项目：${values.project}` : '',
    `评分：${values.score || '未填'}`,
    `评价：${values.comment}`,
    values.tenure ? `在职时长：${form.elements.namedItem('tenure').selectedOptions[0].textContent}` : '',
  ].filter(Boolean).join('\n');
}

async function post(payload, timeout) {
  controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (response.status === 202 && body?.ok) return body;
    const error = new Error(body?.code || `HTTP ${response.status}`);
    error.code = body?.code || '';
    error.status = response.status;
    error.fatal = [400, 403, 409, 413, 422, 429].includes(response.status);
    throw error;
  } finally {
    clearTimeout(timer);
    controller = null;
  }
}

async function attempt(payload) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('timeout');
  return post(payload, Math.min(REQUEST_TIMEOUT, remaining));
}

function clearTimers() {
  clearTimeout(slowTimer);
  slowTimer = null;
  cancelButton.hidden = true;
  controller?.abort();
  controller = null;
}

function showSuccess(submissionId) {
  clearTimers();
  setBusy(false);
  setStatus('');
  form.hidden = true;
  fallbackPanel.hidden = true;
  successPanel.hidden = false;
  receiptEl.textContent = submissionId;
  const slug = companySlugs.get(form.elements.namedItem('companyId').value);
  companyReturn.href = new URL(slug ? 'company/' + encodeURIComponent(slug) + '/' : 'companies/', siteBase).href;
  companyReturn.textContent = slug ? '查看公司主页' : '查看公司目录';
  clearTimeout(saveTimer);
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* 忽略 */ }
  successPanel.querySelector('h2').focus();
}

function showFallback(message) {
  clearTimers();
  setBusy(false);
  saveDraft();
  fallbackPanel.hidden = false;
  setStatus('');
  setFallbackStatus(message || '内容已保存到本机。');
  fallbackPanel.scrollIntoView({ block: 'nearest' });
}

form.addEventListener('input', scheduleSave);
form.addEventListener('change', scheduleSave);
form.elements.namedItem('company')?.addEventListener('input', syncCompanyId);
form.elements.namedItem('company')?.addEventListener('change', syncCompanyId);
for (const name of ['company', 'project', 'anonymousProject']) {
  form.elements.namedItem(name).addEventListener('input', updateSubject);
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy) return;
  if (!form.reportValidity()) return;

  setBusy(true);
  deadline = Date.now() + GLOBAL_TIMEOUT;
  if (!startedAt) startedAt = Date.now();

  const idField = document.querySelector('#submissionId');
  if (!idField.value) idField.value = uuid();

  setStatus('正在准备校验…');
  let pow;
  try {
    pow = await solvePow();
  } catch {
    setStatus('浏览器无法完成本地校验，请换一个浏览器或稍后重试。', true);
    setBusy(false);
    return;
  }
  document.querySelector('#challenge').value = pow.challenge;
  document.querySelector('#nonce').value = pow.nonce;
  document.querySelector('#elapsed').value = String(Math.max(0, Date.now() - startedAt));
  document.querySelector('#js-flag').value = '1';

  const payload = { ...readFields(), submissionId: idField.value, challenge: pow.challenge, nonce: pow.nonce, elapsed: Number(document.querySelector('#elapsed').value), js: true };

  setStatus('正在提交…');
  slowTimer = setTimeout(() => {
    setStatus('网络较慢，仍在尝试…');
    cancelButton.hidden = false;
  }, 3000);

  try {
    const result = await attempt(payload);
    showSuccess(result.receipt || payload.submissionId);
    return;
  } catch (error) {
    if (error.status === 429) {
      clearTimers();
      setBusy(false);
      setStatus('提交太频繁，请稍后再试。', true);
      return;
    }
    if (error.fatal && error.code !== 'UPSTREAM') {
      clearTimers();
      setBusy(false);
      const messages = {
        DUPLICATE: '同类内容近期已提交过。',
        POW_FAILED: '本地校验未通过，请重新提交。',
        FORBIDDEN: '当前来源不被允许。',
        INVALID_INPUT: '内容格式不正确，请检查后重试。',
      };
      setStatus(messages[error.code] || '提交失败，请检查内容后重试。', true);
      return;
    }
    if (Date.now() >= deadline) {
      showFallback('等待超时，内容已保存到本机。');
      return;
    }
    setStatus('正在重试…');
  }

  try {
    const result = await attempt(payload);
    showSuccess(result.receipt || payload.submissionId);
  } catch (error) {
    if (error.status === 429) {
      clearTimers();
      setBusy(false);
      setStatus('提交太频繁，请稍后再试。', true);
      return;
    }
    if (error.fatal && error.code !== 'UPSTREAM') {
      clearTimers();
      setBusy(false);
      setStatus('提交失败，请检查内容后重试。', true);
      return;
    }
    showFallback('两次尝试都未成功，内容已保存到本机。');
  }
});

cancelButton.addEventListener('click', () => showFallback('已取消等待，内容已保存到本机。'));

againButton.addEventListener('click', () => {
  form.reset();
  updateSubject();
  draftNote.hidden = true;
  form.hidden = false;
  successPanel.hidden = true;
  document.querySelector('#submissionId').value = '';
  document.querySelector('#challenge').value = '';
  document.querySelector('#nonce').value = '';
  document.querySelector('#elapsed').value = '';
  document.querySelector('#js-flag').value = '';
  startedAt = Date.now();
  setStatus('');
  form.elements.namedItem('company')?.focus();
});

retryButton.addEventListener('click', () => {
  fallbackPanel.hidden = true;
  form.requestSubmit();
});

copyButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(buildText());
    setFallbackStatus('已复制到剪贴板。');
  } catch {
    setFallbackStatus('复制失败，请手动选择表单内容复制。', true);
  }
});

deleteButton.addEventListener('click', () => {
  try { localStorage.removeItem(DRAFT_KEY); } catch { /* 忽略 */ }
  fallbackPanel.hidden = true;
  setStatus('本地副本已删除。');
});

// Without the script, native form submission omits the disabled project field.
form.elements.namedItem('project').disabled = false;
fillFields({ company: entryCompany, project: entryProject });
restoreDraft();
updateSubject();
loadCompanyCatalog();
