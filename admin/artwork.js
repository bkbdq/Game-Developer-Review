import { h } from './lib/dom.js';
import { isBaikeImage } from './lib/baike-image.js';
import { sizes } from './lib/artwork-sizes.js';
import { publishArtwork } from './lib/artwork-publish.js';
import { readArtworkRepository, artworkUrl } from './lib/artwork-repository.js';
import { createClient } from './lib/github.js';
import { createApi } from './lib/api.js';
import { getToken, setToken, clearToken } from './lib/token.js';
import { config } from './config.js';

const $ = id => document.getElementById(id);
const api = (path, params = {}) => '/api/local/artwork/' + path + '?' + new URLSearchParams(params);
async function request(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const info = await res.json().catch(() => ({}));
    throw Object.assign(new Error(info.message || '请求失败（' + res.status + '）'), {status:res.status});
  }
  return res;
}
let entries = [], active, status = 'all', batch, repository;
let publishing = false;
const proposed = new Set(), checked = new Set();
const STAGE_DB = 'goodcorp-artwork-staging';
// 暂存（含裁切出的图片 Blob）存 IndexedDB；内存里保留一份同步副本，
// directory()/stageReview() 等同步逻辑直接读它。
let stagedMap = {};
function stageDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(STAGE_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore('staged');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function persistStage(map) {
  return stageDb().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction('staged', 'readwrite');
    const store = tx.objectStore('staged');
    store.clear();
    for (const [key, value] of Object.entries(map)) store.put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB 写入被中止'));
  }));
}
async function restoreStage() {
  try { localStorage.removeItem('goodcorp-artwork-staging'); } catch { /* 旧键清理失败不影响 */ }
  try {
    const db = await stageDb();
    const rows = await new Promise((resolve, reject) => {
      const store = db.transaction('staged').objectStore('staged');
      const values = store.getAll(), keys = store.getAllKeys();
      let done = 0;
      const finish = () => resolve(keys.result.map((key, i) => [key, values.result[i]]));
      values.onsuccess = keys.onsuccess = () => { if (++done === 2) finish(); };
      values.onerror = keys.onerror = () => reject(values.error);
    });
    stagedMap = Object.fromEntries(rows.filter(([, s]) => /^[0-9a-f]{16}$/.test(s?.saved?.version || '')));
  } catch { stagedMap = {}; }
}
function loadStage() {
  return stagedMap;
}
// 暂存条目的列表缩略图（本机 card 档的 object URL），条目被移除时回收。
const stagedThumbs = new Map();
function syncStagedThumbs() {
  const map = loadStage();
  for (const [key, url] of stagedThumbs) {
    if (!map[key]) { URL.revokeObjectURL(url); stagedThumbs.delete(key); }
  }
}
function saveStage(map) {
  stagedMap = map;
  persistStage(map).catch(err => {
    const e = active;
    if (e) { e.message = '暂存写入本机失败 · ' + (err.message || err); if (active === e) $('message').textContent = e.message; }
  });
}
function matchingEntries() {
  const kind = $('kind').value;
  const query = $('filter').value.trim().normalize('NFKC').toLocaleLowerCase();
  return entries.filter(e => (kind === 'all' || e.kind === kind) &&
    (e.name + ' ' + e.studio).normalize('NFKC').toLocaleLowerCase().includes(query));
}
function matchesStatus(e) {
  if (status === 'configured') return Boolean(e.remoteSha);
  if (status === 'missing') return Boolean(repository && !e.remoteSha);
  return true;
}
const visible = () => matchingEntries().filter(matchesStatus);
const imageUrl = c => c.local || api('image', { url: c.image });
function fallbackText(e) {
  if (e.kind === 'project') return '显示默认项目图';
  const pictured = entries.some(row => row.company === e.company && row.kind === 'project' && row.remoteSha);
  return pictured ? '待配 Logo · 显示旗下项目图' : '待配 Logo · 显示默认图';
}
const stateText = e => e.saving ? '提交中' : e.changed ? '待提交' : e.remoteSha ? '已配图' : e.draft ? '本机草稿' : repository ? fallbackText(e) : '未同步';

function viewUrl(entry) {
  const url = new URL('/artwork.html',location.origin);
  if ($('filter').value) url.searchParams.set('q',$('filter').value);
  if ($('kind').value !== 'all') url.searchParams.set('kind',$('kind').value);
  if (status !== 'all') url.searchParams.set('status',status);
  if (entry) { url.searchParams.set('company',entry.company); url.searchParams.set('target',entry.target); }
  return url.pathname + url.search;
}

function directory() {
  if (active) return;
  const matches = matchingEntries(), list = matches.filter(matchesStatus);
  const configured = matches.filter(e => e.remoteSha).length;
  const counts = {all:matches.length, configured, missing:matches.length - configured};
  const labels = {all:'全部', configured:'已配图', missing:'待补专图'};
  for (const btn of $('statuses').children) {
    const key = btn.dataset.status;
    btn.textContent = labels[key] + ' ' + (repository || key === 'all' ? counts[key] : '—');
    btn.setAttribute('aria-pressed', String(key === status));
    btn.disabled = !repository && key !== 'all';
  }
  $('targets').replaceChildren(...list.map(e => {
    const skey = e.company + '/' + e.target;
    const staged = Boolean(loadStage()[skey]);
    // 暂存条目直接用本机暂存的 card 档做缩略图，暂存后列表立刻可见。
    let thumb = e.thumbnail;
    if (staged) {
      if (!stagedThumbs.has(skey)) stagedThumbs.set(skey, URL.createObjectURL(webpFile(loadStage()[skey].files.card)));
      thumb = stagedThumbs.get(skey);
    }
    const thumbnail = h('span', {class:'thumbnail', 'aria-hidden':'true'}, e.kind === 'company' ? '企' : '项');
    if (thumb) thumbnail.append(h('img', {src:thumb, alt:'', loading:'lazy', referrerPolicy:'no-referrer', onerror:ev=>ev.target.remove()}));
    const link = h('a', {href:viewUrl(e), class:'manage-link', 'aria-label':(e.remoteSha ? '编辑配图：' : staged ? '继续编辑：' : '配置图片：') + e.name,
      onclick:ev => { if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return; ev.preventDefault(); openEntry(e); }},
      e.remoteSha ? '编辑配图' : staged ? '继续编辑' : e.changed ? '继续配图' : '配置图片');
    return h('tr', {}, h('th', {scope:'row'}, h('div', {class:'identity'}, thumbnail, h('span', {}, h('strong', {}, e.name),
      h('small', {}, e.kind === 'company' ? '公司' : '项目 · ' + e.studio)))),
      h('td', {}, h('span', {class:'status' + (e.remoteSha ? ' ready' : '')},
        e.remoteSha && e.changed ? '已配图 · 待提交' : staged && !e.changed ? (e.remoteSha ? '已配图 · 已暂存' : '已暂存') : stateText(e))),
      h('td', {}, link));
  }));
  $('count').textContent = '显示 ' + list.length + ' / ' + entries.length + ' 项';
  $('empty').hidden = Boolean(list.length);
  $('empty').textContent = status === 'configured' && !configured ? '当前范围内还没有已配图的条目。' : '没有匹配的已收录条目。请核对名称或调整筛选条件。';
  $('batch').disabled = batch ? batch.stop : !repository || !list.some(e=>!e.remoteSha);
}

function draw() {
  const e = active;
  if (!e) return;
  $('name').textContent = e.name;
  $('context').textContent = e.kind === 'project' ? e.studio + ' / 项目' : '公司';
  $('state').textContent = stateText(e);
  $('query').value = e.term;
  $('search-sources').textContent = e.kind === 'company' ? '图片来源：已核实的公司标志、Steam 开发者主页、百度百科、维基共享资源、英文维基百科' : '图片来源：Steam、TapTap、腾讯应用宝、百度百科、英文维基百科';
  updateWebSearch(e);
  const found = e.dsCandidates || [];
  const promoted = new Set(found.map(c => c.image));
  $('candidates').replaceChildren(...[...found, ...e.candidates.filter(c => !promoted.has(c.image))].map(c => h('button', {
    class: 'candidate', title: c.provider + ' · ' + c.title, disabled: e.saving,
    'aria-pressed': String(e.pick === c || Boolean(c.image && e.pick?.image === c.image)), onclick: () => choose(e, c),
  }, h('img', { src: imageUrl(c), alt: '', loading: 'lazy' }), h('span', {}, c.title), h('small', {}, c.provider))));
  $('search-status').textContent = e.searchStatus || '';
  $('ds-search').disabled = e.saving || Boolean(e.dsBusy);
  $('ds-status').textContent = e.dsStatus || '';
  $('mode').value = e.mode;
  $('x').value = e.x;
  $('y').value = e.y;
  $('edit').hidden = !e.pick;
  $('legacy').hidden = !e.draft || !e.remoteSha || e.draft.version === e.saved?.version;
  $('legacy').disabled = e.saving;
  $('file').disabled = e.saving;
  $('mode').disabled = e.saving;
  $('search').querySelector('button').disabled = e.saving;
  $('x').disabled = $('y').disabled = e.mode === 'contain' || e.saving;
  $('save').disabled = !e.pick || !e.changed || publishing || !e.loaded;
  $('save').textContent = e.remoteSha ? '保存配图修改' : '提交配图';
  $('stage').hidden = !e.pick || !e.loaded;
  $('stage').disabled = e.saving || publishing;
  $('stage').title = '按当前裁切生成展示图并暂存到本机浏览器，稍后批量上传';
  $('discard').hidden = !e.current || !e.changed;
  $('discard').disabled = e.saving;
  $('message').textContent = e.message || '确认后将展示图保存到 Cloudflare R2，原图不进存储桶。';
  $('source').replaceChildren();
  if (e.pick) {
    $('source').append(e.pick.provider + ' · ' + e.pick.title);
    if (e.pick.page) $('source').append('　', h('a', { href:e.pick.page, target:'_blank', rel:'noopener noreferrer' }, '查看来源 ↗'));
  }
  $('previews').replaceChildren(...sizes[e.kind].map(s => {
    const frame = h('div', {class:'frame'});
    frame.style.aspectRatio = s.width + '/' + s.height;
    if (e.pick) frame.append(h('img', {src: imageUrl(e.pick), alt: e.name + '的' + s.label + '预览'}));
    return h('figure', {}, frame, h('figcaption', {}, s.label, h('small', {}, s.width + ' × ' + s.height)));
  }));
  position();
}

function position() {
  if (!active) return;
  for (const img of $('previews').querySelectorAll('img')) {
    img.style.objectFit = active.mode;
    img.style.objectPosition = active.mode === 'contain' ? 'center' : active.x + '% ' + active.y + '%';
  }
}

function refresh(e) {
  directory();
  if (e === active) draw();
  batchReview();
  stageReview();
}

function choose(e, candidate, existing = '') {
  if (e.saving) return;
  const previous = e.pick;
  if (previous?.local?.startsWith('blob:') && previous !== candidate && previous !== e.current &&
      !e.dsCandidates?.includes(previous)) URL.revokeObjectURL(previous.local);
  if (previous !== candidate) checked.delete(e);
  e.pick = candidate;
  if (existing) {
    e.x = candidate.x; e.y = candidate.y; e.mode = candidate.mode; e.changed = existing === 'draft';
  } else { e.changed = true; e.x = e.y = 50; e.mode = e.kind === 'company' ? 'contain' : 'cover'; }
  e.loaded = false;
  e.message = '正在读取原图…';
  refresh(e);
  const img = new Image();
  img.onload = () => {
    if (e.pick !== candidate) return;
    e.loaded = true;
    const origin = candidate.storage === 'r2' ? '记录的图片出处' : '仓库 main';
    e.message = '原图 ' + img.naturalWidth + ' × ' + img.naturalHeight + (existing === 'remote' ? ' · 来自' + origin : existing === 'draft' ? ' · 本机旧草稿，可直接提交' : existing === 'staged' ? ' · 本机暂存，可调整后重新暂存或直接批量上传' : ' · 确认后可提交');
    refresh(e);
  };
  img.onerror = () => {
    if (e.pick !== candidate) return;
    e.message = '这张图暂时无法读取，请选其他候选图或从本机选图。';
    refresh(e);
  };
  e.reading = new Promise(resolve => {
    img.addEventListener('load', () => resolve(e.pick === candidate && e.loaded), {once:true});
    img.addEventListener('error', () => resolve(false), {once:true});
  });
  img.src = imageUrl(candidate);
  return e.reading;
}

async function search(e, term, batchLookup = false) {
  const ticket = ++e.ticket;
  e.term = term;
  if (e.dsTerm && e.dsTerm !== term) {
    clearDeepSeekCandidates(e);
    e.dsTerm = '';
    e.dsStatus = '';
  }
  e.searchStatus = '正在查找「' + term + '」…';
  if (active === e) draw();
  try {
    const result = await (await request(api('search', {q:term, kind:e.kind, studio:e.studio, batch:batchLookup ? '1' : '0'}))).json();
    if (ticket !== e.ticket) return;
    e.candidates = result.candidates;
    e.baikeQuery = term;
    e.baikeTitle = result.lookup;
    e.searched = true;
    const counts = new Map();
    for (const c of e.candidates) counts.set(c.provider, (counts.get(c.provider) || 0) + 1);
    const found = counts.size ? [...counts].map(([source,n]) => source + ' ' + n + ' 张').join('，') : '没有找到候选图，可换用正式名称或英文名。';
    e.searchStatus = [result.lookup && result.lookup !== term ? '按「' + result.lookup + '」查找' : '', found, ...result.warnings].filter(Boolean).join(' · ');
    if (result.baikeConfigured === false) e.searchStatus += ' · 百度百科自动取图需配置密钥。可打开词条，复制图片或图片地址，在此页按 Ctrl+V。';
    if (result.choice === -1) e.searchStatus += ' · AI 未找到可靠匹配，请人工核对';
    else if (result.choice != null) e.searchStatus += ' · AI 推荐已排在首位';
    const first = e.candidates.find(c => c.batchMatch);
    if (first && result.choice !== -1 && !e.remoteSha && !e.saving && !e.pick) await choose(e, first);
  } catch (err) {
    if (ticket !== e.ticket) return;
    e.searchStatus = err.message;
  }
  refresh(e);
}

function openEntry(e, navigate = true) {
  active = e;
  if (navigate) history.pushState(null,'',viewUrl(e));
  $('manager').hidden = true;
  $('editor').hidden = false;
  $('back').href = $('home').href = viewUrl();
  window.scrollTo(0,0);
  draw();
  if (e.pick || e.loading) return;
  const staged = loadStage()[e.company + '/' + e.target];
  if (staged) { openStaged(e, staged); return; }
  if (e.remoteSha) void openRemote(e);
  else if (e.draft) openDraft(e);
  else if (!e.searched && !e.ticket) void search(e, e.term);
}

// 从本机暂存恢复编辑：原图就在 IndexedDB 里，不联网、不触发搜索。
function openStaged(e, s) {
  const file = webpFile(s.source);
  choose(e, {...s.saved, file, local:URL.createObjectURL(file)}, 'staged');
}

function openDraft(e) {
  const draft = e.draft;
  choose(e, { ...draft, local:api('original', {company:e.company,target:e.target,v:draft.version}) }, 'draft');
}
$('legacy').onclick = () => openDraft(active);
$('discard').onclick = () => choose(active, active.current, 'remote');

async function openRemote(e) {
  e.loading = true; e.message = '正在按记录的出处读取原图…'; refresh(e);
  try {
    const {saved,file} = await repository.original(e);
    e.saved = saved;
    e.current = { ...saved, file, local:URL.createObjectURL(file) };
    if (!e.pick) choose(e, e.current, 'remote');
  } catch (err) { e.message = err.message; refresh(e); }
  finally { e.loading = false; }
}

function batchRows() {
  return visible().filter(e => proposed.has(e) && !e.remoteSha && e.pick);
}
function selectableRows() {
  return batchRows().filter(e => e.loaded && !e.saving);
}
$('batch-select').onclick = () => {
  const rows = selectableRows();
  const clear = rows.every(e => checked.has(e));
  for (const e of rows) { if (clear) checked.delete(e); else checked.add(e); }
  batchReview();
};
function batchReview() {
  const rows = batchRows();
  $('batch-review').hidden = !rows.length;
  $('batch-items').replaceChildren(...rows.map(e => {
    const box = h('input', { type:'checkbox', checked:checked.has(e), disabled:publishing || e.saving || !e.loaded,
      onchange:ev => { if (ev.target.checked) checked.add(e); else checked.delete(e); batchReview(); } });
    return h('div', {class:'proposal'}, h('label', {}, box, h('img', {src:imageUrl(e.pick), alt:''}),
      h('span', {}, h('strong', {}, e.name), h('small', {}, e.pick.provider + ' · ' + e.pick.title))),
      h('button', {onclick: () => openEntry(e)}, '核对'));
  }));
  const eligible = selectableRows();
  const count = eligible.filter(e => checked.has(e)).length;
  $('batch-select').disabled = publishing || !eligible.length;
  $('batch-select').textContent = eligible.length && count === eligible.length ? '取消全选' : '全选候选（' + eligible.length + '）';
  $('batch-save').textContent = '提交勾选的配图（' + count + '）';
  $('batch-save').disabled = publishing || !count;
}

async function prepare(e) {
  const photo = e.pick;
  const bytes = photo.file || await (await request(imageUrl(photo))).blob();
  const params = { company:e.company, target:e.target, mode:e.mode, x:e.x, y:e.y,
    provider:photo.provider, title:photo.title, page:photo.page || '', image:photo.image || '' };
  return (await request(api('prepare', params), {method:'POST', headers:{'X-Artwork-Save':'1'}, body:bytes})).json();
}

function webpFile(encoded) {
  const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
  return new Blob([bytes], {type:'image/webp'});
}

async function uploadArtwork(token, item, version, files) {
  const form = new FormData();
  for (const [key,bytes] of Object.entries(files)) form.append(key,webpFile(bytes),key + '.webp');
  const path = '/api/admin/artwork/' + [item.company,item.target,version].join('/');
  const response = await request(path,{method:'POST',headers:{Authorization:'Bearer ' + token},body:form});
  const receipt = await response.json().catch(() => null);
  if (receipt?.ok !== true || receipt.version !== version) throw new Error('后台尚未确认 R2 上传，请检查配图服务部署');
}

function showManager() {
  active = null;
  $('editor').hidden = true;
  $('manager').hidden = false;
  directory(); batchReview();
}
function followLocation() {
  const params = new URLSearchParams(location.search);
  $('filter').value = params.get('q') || '';
  $('kind').value = ['project','company'].includes(params.get('kind')) ? params.get('kind') : 'all';
  status = repository && ['configured','missing'].includes(params.get('status')) ? params.get('status') : 'all';
  const selected = entries.find(e => e.company === params.get('company') && e.target === params.get('target'));
  if (selected) openEntry(selected, false);
  else showManager();
}
function updateFilters() {
  history.replaceState(null,'',viewUrl());
  directory(); batchReview();
}
for (const id of ['back','home']) $(id).onclick = ev => {
  if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return;
  ev.preventDefault();
  if (active) history.pushState(null,'',viewUrl());
  showManager();
  $('filter').focus();
};
window.addEventListener('popstate', followLocation);
$('statuses').onclick = ev => {
  if (!ev.target.dataset.status) return;
  status = ev.target.dataset.status;
  updateFilters();
};
$('filter').oninput = updateFilters;
$('ds-search').onclick = () => {
  if (active && $('query').reportValidity()) void searchDeepSeek(active);
};
function clearDeepSeekCandidates(e) {
  for (const c of e.dsCandidates || []) if (c !== e.pick) URL.revokeObjectURL(c.local);
  e.dsCandidates = [];
}
async function searchDeepSeek(e, batchLookup = false) {
  const term = e.term.trim();
  if (!term || e.dsBusy || e.saving) return;
  e.dsBusy = true;
  e.dsError = null;
  if (term !== e.dsTerm) {
    clearDeepSeekCandidates(e);
    e.dsTerm = term;
  }
  e.dsStatus = '正在为「' + term + '」查找并读取候选图…';
  refresh(e);
  const params = new URLSearchParams({q:term,kind:e.kind,studio:e.studio});
  if (e.kind === 'company') {
    const works = entries.filter(row => row.company === e.company && row.kind === 'project').map(row => row.name);
    for (const work of [...new Set(works)].slice(0,5)) params.append('work',work);
  }
  const path = api('deepseek', params);
  try {
    const run = token => request(path, {method:'POST', headers:{
      'X-Artwork-Save':'1', ...(token ? {Authorization:'Bearer ' + token} : {}),
    }});
    let response;
    try { response = await run(getToken()); }
    catch (err) {
      if (err.status !== 401 || batchLookup) throw err;
      clearToken();
      const token = await askForToken();
      if (!token) { e.dsStatus = '已取消共享找图。'; return; }
      response = await run(token);
      setToken(token);
    }
    const result = await response.json();
    if (term !== e.term.trim()) { e.dsStatus = '关键词已更改，请重新找图。'; return; }
    clearDeepSeekCandidates(e);
    e.dsCandidates = result.candidates.map(({webp,...c}) => {
      const file = webpFile(webp);
      return {...c,file,local:URL.createObjectURL(file)};
    });
    const count = e.dsCandidates.length;
    if (count) {
      const providers = [...new Set(e.dsCandidates.map(c => c.provider))].join('、');
      const found = e.dsCandidates.some(c => c.provider === 'DeepSeek') ? '找到' : 'DeepSeek 未取到可用原图，常规来源补充了';
      e.dsStatus = found + ' ' + count + ' 张图片（' + providers + '），已放在选择栏最前面。';
      const first = e.dsCandidates.find(c => c.provider === 'DeepSeek' || c.batchMatch);
      if (first && !e.remoteSha && (!e.pick || !e.loaded) && !e.saving) await choose(e, first);
      if (active === e) $('candidates').scrollLeft = 0;
    } else e.dsStatus = '未找到可用图片。请换用项目正式名称、英文名或公司全称。';
  } catch (err) {
    e.dsError = err;
    e.dsStatus = err.message;
  } finally { e.dsBusy = false; refresh(e); }
}
$('kind').onchange = updateFilters;
$('search').onsubmit = ev => {
  ev.preventDefault();
  const q = $('query').value.trim();
  if (q && active && !active.saving) void search(active, q);
};
function updateWebSearch(entry) {
  const term = entry.term.trim() || entry.name;
  const baikeTitle = term === entry.baikeQuery && entry.baikeTitle ? entry.baikeTitle : term;
  $('baike-page').href = 'https://baike.baidu.com/item/' + encodeURIComponent(baikeTitle);
  const params = new URLSearchParams({q:term + (entry.kind === 'company' ? ' 公司 logo' : ' 游戏 官方宣传图')});
  $('web-search').href = 'https://www.bing.com/images/search?' + params;
}
$('query').oninput = () => {
  if (!active) return;
  active.term = $('query').value;
  updateWebSearch(active);
};
$('file').onchange = () => {
  const file = $('file').files[0]; $('file').value = '';
  chooseFile(file, '本机图片');
};
document.addEventListener('paste', ev => {
  if (!active || active.saving || $('signin').open) return;
  const address = ev.clipboardData?.getData('text/plain')?.trim();
  if (isBaikeImage(address)) {
    ev.preventDefault();
    choose(active, {provider:'百度百科', title:active.name, image:address, page:address});
    return;
  }
  const item = Array.from(ev.clipboardData?.items || []).find(item => item.kind === 'file' && item.type.startsWith('image/'));
  if (!item) return;
  ev.preventDefault();
  chooseFile(item.getAsFile(), '剪贴板图片');
});
function chooseFile(file, provider) {
  if (!file || !active || active.saving) return;
  if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 12 * 1024 * 1024) {
    active.message = '请选择 12 MB 以内的 JPEG、PNG 或 WebP。'; draw(); return;
  }
  choose(active, { provider, title:active.name, local:URL.createObjectURL(file), file });
}
for (const id of ['mode','x','y']) $(id).oninput = () => {
  const e = active;
  e.mode = $('mode').value; e.x = Number($('x').value); e.y = Number($('y').value);
  e.changed = true; e.message = '裁切已调整，确认后可提交。';
  $('message').textContent = e.message; $('state').textContent = stateText(e);
  $('x').disabled = $('y').disabled = e.mode === 'contain';
  $('save').disabled = !e.loaded || publishing;
  $('discard').hidden = !e.current;
  position();
};
function askForToken() {
  const dialog = $('signin'), input = $('token');
  dialog.returnValue = 'cancel';
  input.value = '';
  return new Promise(resolve => {
    dialog.addEventListener('close', () => {
      const value = dialog.returnValue === 'submit' ? input.value.trim() : '';
      input.value = '';
      resolve(value);
    }, {once:true});
    dialog.showModal();
  });
}

async function publish(items, report, onDone) {
  if (publishing || !items.length) return;
  publishing = true;
  items.forEach(e => { e.saving = true; });
  directory(); draw(); batchReview();
  try {
    const token = getToken() || await askForToken();
    if (!token) return;
    report('正在验证管理员身份…');
    try { await createApi(token).me(); }
    catch (err) {
      if (err.status === 401 || err.status === 403) clearToken();
      throw err;
    }
    setToken(token);
    const stagedCount = items.filter(e => e.staged).length;
    report(stagedCount === items.length ? '正在上传暂存的展示图并提交记录…' : '正在将展示图保存到 Cloudflare R2…');
    const previews = new Map();
    const result = await publishArtwork({client:createClient(token), config, items, upload:(...args)=>uploadArtwork(token,...args), prepare:async e => {
      if (e.staged) {
        // 暂存条目已在本机裁切好，批量时直接复用成品上传。
        previews.set(e, {source:webpFile(e.staged.source), card:webpFile(e.staged.files.card)});
        return {saved:e.staged.saved, source:e.staged.source, files:e.staged.files};
      }
      const prepared = await prepare(e);
      previews.set(e, {source:webpFile(prepared.source), card:webpFile(prepared.files.card)});
      return prepared;
    }});
    items.forEach((e,i) => {
      const record = result.records[i];
      e.saved = record.saved; e.remoteSha = record.sha; e.changed = false;
      for (const url of new Set([e.current?.local, e.pick?.local, e.thumbnail])) {
        if (url?.startsWith('blob:') && !e.dsCandidates?.some(c => c.local === url)) URL.revokeObjectURL(url);
      }
      const preview = previews.get(e);
      if (preview) {
        e.current = { ...record.saved, file:preview.source, local:URL.createObjectURL(preview.source) };
        e.pick = e.current;
        e.thumbnail = URL.createObjectURL(preview.card);
      } else {
        e.current = { ...record.saved };
        e.pick = e.current;
        e.thumbnail = artworkUrl(e, record.saved.version, 'card');
      }
      e.message = result.message;
      checked.delete(e); proposed.delete(e);
    });
    report(result.message);
    if (onDone) onDone(result);
  } catch (err) { report('提交失败 · ' + err.message + '。当前选图仍在页面中。'); }
  finally {
    publishing = false;
    items.forEach(e => { e.saving = false; });
    directory(); draw(); batchReview(); stageReview();
  }
}
$('save').onclick = () => {
  const e = active;
  void publish([e], message => { e.message = message; if (active === e) $('message').textContent = message; });
};
$('batch').onclick = async () => {
  if (batch) { batch.stop = true; $('batch').disabled = true; return; }
  batch = {stop:false};
  if (!publishing) $('batch-publish-status').hidden = true;
  const todo = visible().filter(e => !e.remoteSha);
  let done = 0, dsCount = 0, dsFailure = '';
  $('batch').textContent = '停止批量查找'; $('batch-status').hidden = false;
  for (const e of todo) {
    if (batch.stop) break;
    $('batch-status').textContent = '正在查找 ' + (done + 1) + ' / ' + todo.length + ' · ' + e.name;
    if (!e.pick) await search(e, e.term, true);
    if (e.reading) await e.reading;
    if (e.loaded) proposed.add(e);
    done++; batchReview();
  }
  const remaining = todo.filter(e => !e.remoteSha && !e.loaded);
  for (const e of remaining) {
    if (batch.stop || dsFailure) break;
    if (e.remoteSha || e.loaded) continue;
    $('batch-status').textContent = '常规查找已完成。DeepSeek 补查 ' + (dsCount + 1) + ' / ' + remaining.length + ' · ' + e.name;
    dsCount++;
    await searchDeepSeek(e, true);
    if ([401,402,403,429,503].includes(e.dsError?.status)) dsFailure = e.dsError.message;
    if (e.loaded && !e.remoteSha) proposed.add(e);
    batchReview();
  }
  $('batch-status').textContent = '已检查 ' + done + ' 项，找到 ' + todo.filter(e => proposed.has(e)).length + ' 项候选。DeepSeek 已补查 ' + dsCount + ' 项。' + (dsFailure ? '后续 AI 补查已暂停：' + dsFailure + '。' : '') + '请核对归属后勾选提交。';
  batch = null; $('batch').textContent = '批量查找缺图'; directory();
};
$('batch-save').onclick = () => {
  const list = selectableRows().filter(e => checked.has(e));
  const receipt = $('batch-publish-status');
  receipt.hidden = false;
  void publish(list, msg => { receipt.textContent = msg; });
};

let stageThumbs = [];
function stageReview() {
  const map = loadStage();
  const items = Object.entries(map);
  syncStagedThumbs();
  for (const url of stageThumbs) URL.revokeObjectURL(url);
  stageThumbs = [];
  $('stage-review').hidden = !items.length;
  $('stage-items').replaceChildren(...items.map(([key, s]) => {
    const thumb = URL.createObjectURL(webpFile(s.files.card));
    stageThumbs.push(thumb);
    const entry = entries.find(row => row.company === s.company && row.target === s.target);
    const open = entry ? () => openEntry(entry) : null;
    return h('div', {class:'proposal'},
      h('img', {src:thumb, alt:'', referrerPolicy:'no-referrer', ...(open ? {onclick:open, class:'staged-open'} : {})}),
      h('span', {class: open ? 'staged-open' : '', title: open ? '打开继续编辑' : '', ...(open ? {onclick:open} : {})},
        h('strong', {}, s.name), h('small', {}, s.saved.provider + ' · ' + s.saved.title + ' · 待上传')),
      h('button', {type:'button', 'aria-label':'移除暂存：' + s.name, onclick:() => {
        const rest = loadStage(); delete rest[key]; saveStage(rest);
        stageReview(); directory();
      }}, '移除'));
  }));
  $('stage-upload').textContent = '批量上传暂存（' + items.length + '）';
  $('stage-upload').disabled = publishing || !items.length || !repository;
  $('stage-clear').disabled = publishing || !items.length;
}
$('stage-clear').onclick = () => {
  if (publishing) return;
  saveStage({});
  stageReview(); directory();
};
$('stage-upload').onclick = () => {
  if (publishing || !repository) return;
  const map = loadStage();
  const items = [], skipped = [];
  for (const s of Object.values(map)) {
    const e = entries.find(row => row.company === s.company && row.target === s.target);
    if (!e || e.saving) { skipped.push(s.name); continue; }
    e.staged = s;
    e.changed = true;
    items.push(e);
  }
  $('batch-status').hidden = false;
  if (!items.length) {
    $('batch-status').textContent = skipped.length ? '暂存条目已不在当前目录中，请在暂存区移除后重试。' : '';
    return;
  }
  const keys = items.map(e => e.company + '/' + e.target);
  void publish(items, msg => { $('batch-status').textContent = msg; }, () => {
    const rest = loadStage();
    for (const key of keys) delete rest[key];
    saveStage(rest);
    stageReview(); directory();
    if (skipped.length) $('batch-status').textContent += '（另有 ' + skipped.length + ' 项未找到对应条目，仍保留在暂存区）';
  });
};
$('stage').onclick = async () => {
  const e = active;
  if (!e || !e.pick || !e.loaded || e.saving || publishing) return;
  e.saving = true;
  e.message = '正在按当前裁切生成展示图，暂存到本机浏览器…';
  refresh(e);
  try {
    const prepared = await prepare(e);
    const map = {...loadStage(), [e.company + '/' + e.target]: {saved: prepared.saved, files: prepared.files,
      source: prepared.source, company:e.company, target:e.target, name:e.name, kind:e.kind,
      studio:e.studio, at:Date.now()}};
    await persistStage(map);
    stagedMap = map;
    e.message = '已按当前裁切暂存到本机浏览器（尚未上传），回到配图管理可批量上传。';
    stageReview();
  } catch (err) {
    e.message = '暂存失败 · ' + (err.message || err);
  } finally {
    e.saving = false;
    refresh(e);
  }
};
try {
  let data = await (await request(api('catalog'))).json();
  try {
    repository = await readArtworkRepository(data, getToken());
    data = repository.rows;
    $('repo-status').hidden = true;
  } catch (err) {
    $('repo-status').textContent = '仓库目录暂未同步，当前显示本机条目。' + err.message;
  }
  entries = data.map(e => ({ ...e, draft:e.draft?.storage === 'r2' ? null : e.draft, remoteSha:e.remoteSha ?? null, term:e.name, candidates:[], ticket:0,
    x:50, y:50, mode:e.kind === 'company' ? 'contain' : 'cover' }));
  await restoreStage();
  followLocation();
  stageReview();
} catch (err) {
  $('repo-status').textContent = '无法读取目录。请从项目的 start-artwork.cmd 启动工具。' + err.message;
}
