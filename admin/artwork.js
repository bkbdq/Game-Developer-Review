import { h } from './lib/dom.js';
import { isBaikeImage } from './lib/baike-image.js';
import { sizes } from './lib/artwork-sizes.js';
import { publishArtwork } from './lib/artwork-publish.js';
import { readArtworkRepository } from './lib/artwork-repository.js';
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
const STAGE_KEY = 'goodcorp-artwork-staging';
function loadStage() {
  try {
    const map = JSON.parse(localStorage.getItem(STAGE_KEY) || '{}');
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  } catch { return {}; }
}
function saveStage(map) {
  try { localStorage.setItem(STAGE_KEY, JSON.stringify(map)); }
  catch { /* 本机暂存写不进时不阻塞浏览 */ }
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
const stateText = e => e.saving ? '提交中' : e.changed ? '待提交' : e.remoteSha ? '已配图' : e.draft ? '本机草稿' : repository ? '缺图' : '未同步';

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
  const labels = {all:'全部', configured:'已配图', missing:'缺图'};
  for (const btn of $('statuses').children) {
    const key = btn.dataset.status;
    btn.textContent = labels[key] + ' ' + (repository || key === 'all' ? counts[key] : '—');
    btn.setAttribute('aria-pressed', String(key === status));
    btn.disabled = !repository && key !== 'all';
  }
  $('targets').replaceChildren(...list.map(e => {
    const staged = Boolean(loadStage()[e.company + '/' + e.target]);
    const thumbnail = h('span', {class:'thumbnail', 'aria-hidden':'true'}, e.kind === 'company' ? '企' : '项');
    if (e.thumbnail) thumbnail.append(h('img', {src:e.thumbnail, alt:'', loading:'lazy', referrerPolicy:'no-referrer', onerror:ev=>ev.target.remove()}));
    const link = h('a', {href:viewUrl(e), class:'manage-link', 'aria-label':(e.remoteSha ? '编辑配图：' : '配置图片：') + e.name,
      onclick:ev => { if (ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.altKey) return; ev.preventDefault(); openEntry(e); }},
      e.remoteSha ? '编辑配图' : e.changed ? '继续配图' : '配置图片');
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
  $('search-sources').textContent = e.kind === 'company' ? '图片来源：Steam 开发者主页、百度百科、维基共享资源、英文维基百科' : '图片来源：Steam、TapTap、腾讯应用宝、百度百科、英文维基百科';
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
  $('stage').disabled = e.saving || publishing || !e.pick?.image;
  $('stage').title = e.pick?.image ? '保存到本机暂存区，稍后在配图管理批量上传' : '这张图没有出处地址（本机图片），无法暂存，请直接提交';
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
    const origin = candidate.storage === 'r2' ? 'Cloudflare R2' : '仓库 main';
    e.message = '原图 ' + img.naturalWidth + ' × ' + img.naturalHeight + (existing === 'remote' ? ' · 来自' + origin : existing === 'draft' ? ' · 本机旧草稿，可直接提交' : ' · 确认后可提交');
    refresh(e);
  };
  img.onerror = () => {
    if (e.pick !== candidate) return;
    e.message = '这张图暂时无法读取，请选其他候选图或从本机选图。';
    refresh(e);
  };
  img.src = imageUrl(candidate);
}

async function search(e, term) {
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
    const result = await (await request(api('search', {q:term, kind:e.kind}))).json();
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
    if (e.candidates.length && result.choice !== -1 && !e.remoteSha && !e.saving && !e.pick) choose(e, e.candidates[0]);
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
  if (e.remoteSha) void openRemote(e);
  else if (e.draft) openDraft(e);
  else if (!e.searched && !e.ticket) void search(e, e.term);
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

function batchReview() {
  const rows = [...proposed].filter(e => !e.remoteSha && e.pick);
  $('batch-review').hidden = !rows.length;
  $('batch-items').replaceChildren(...rows.map(e => {
    const box = h('input', { type:'checkbox', checked:checked.has(e), disabled:publishing || e.saving || !e.loaded,
      onchange:ev => { if (ev.target.checked) checked.add(e); else checked.delete(e); batchReview(); } });
    return h('div', {class:'proposal'}, h('label', {}, box, h('img', {src:imageUrl(e.pick), alt:''}),
      h('span', {}, h('strong', {}, e.name), h('small', {}, e.pick.provider + ' · ' + e.pick.title))),
      h('button', {onclick: () => openEntry(e)}, '核对'));
  }));
  const count = rows.filter(e => checked.has(e) && e.loaded).length;
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
  directory();
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
async function searchDeepSeek(e) {
  const term = e.term.trim();
  if (!term || e.dsBusy || e.saving) return;
  e.dsBusy = true;
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
      if (err.status !== 401) throw err;
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
      if (!e.remoteSha && !e.pick && !e.saving) choose(e,e.dsCandidates[0]);
      if (active === e) $('candidates').scrollLeft = 0;
    } else e.dsStatus = '未找到可用图片。请换用项目正式名称、英文名或公司全称。';
  } catch (err) {
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
    report('正在将展示图保存到 Cloudflare R2…');
    const previews = new Map();
    const result = await publishArtwork({client:createClient(token), config, items, upload:(...args)=>uploadArtwork(token,...args), prepare:async e => {
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
      const {source,card} = previews.get(e);
      e.current = { ...record.saved, file:source, local:URL.createObjectURL(source) };
      e.pick = e.current;
      e.thumbnail = URL.createObjectURL(card);
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
  const todo = visible().filter(e => !e.remoteSha);
  let done = 0;
  $('batch').textContent = '停止批量查找'; $('batch-status').hidden = false;
  for (const e of todo) {
    if (batch.stop) break;
    $('batch-status').textContent = '正在查找 ' + (done + 1) + ' / ' + todo.length + ' · ' + e.name;
    if (!e.pick) await search(e, e.term);
    if (e.pick) proposed.add(e);
    done++; batchReview();
  }
  $('batch-status').textContent = '已检查 ' + done + ' 项，找到 ' + todo.filter(e => proposed.has(e)).length + ' 项候选。勾选归属正确的配图后可一起提交。';
  batch = null; $('batch').textContent = '批量查找缺图'; directory();
};
$('batch-save').onclick = () => {
  const list = [...checked].filter(e => !e.remoteSha && e.loaded);
  $('batch-status').hidden = false;
  void publish(list, msg => { $('batch-status').textContent = msg; });
};

function stageReview() {
  const map = loadStage();
  const items = Object.entries(map);
  $('stage-review').hidden = !items.length;
  $('stage-items').replaceChildren(...items.map(([key, s]) => h('div', {class:'proposal'},
    h('img', {src:api('image', {url:s.image}), alt:'', referrerPolicy:'no-referrer'}),
    h('span', {}, h('strong', {}, s.name), h('small', {}, s.provider + ' · ' + s.title)),
    h('button', {type:'button', 'aria-label':'移除暂存：' + s.name, onclick:() => {
      const rest = loadStage(); delete rest[key]; saveStage(rest);
      stageReview(); directory();
    }}, '移除'))));
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
    e.pick = {provider:s.provider, title:s.title, page:s.page, image:s.image};
    e.mode = s.mode; e.x = Number(s.x); e.y = Number(s.y);
    e.changed = true; e.loaded = false; e.message = '';
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
$('stage').onclick = () => {
  const e = active;
  if (!e || !e.pick?.image || e.saving || publishing) return;
  const map = loadStage();
  map[e.company + '/' + e.target] = {company:e.company, target:e.target, name:e.name, kind:e.kind, studio:e.studio,
    mode:e.mode, x:e.x, y:e.y, provider:e.pick.provider, title:e.pick.title || e.name,
    page:e.pick.page || '', image:e.pick.image, at:Date.now()};
  saveStage(map);
  e.message = '已暂存到本机浏览器，回到配图管理可批量上传。';
  if (active === e) $('message').textContent = e.message;
  directory(); batchReview(); stageReview();
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
  followLocation();
  stageReview();
} catch (err) {
  $('repo-status').textContent = '无法读取目录。请从项目的 start-artwork.cmd 启动工具。' + err.message;
}
