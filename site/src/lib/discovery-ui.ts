import { getBoardPageSizes } from './project-board';

function setupFeatured(feature: HTMLElement) {
  const slides = Array.from(feature.querySelectorAll<HTMLElement>('[data-slide]'));
  const dots = Array.from(feature.querySelectorAll<HTMLButtonElement>('[data-dot]'));
  const stage = feature.querySelector<HTMLElement>('.feature-stage')!;
  let current = 0;
  if(slides.length<2) return;
  const track = stage.querySelector<HTMLElement>('.feature-track')!;
  const cards = Array.from(track.children) as HTMLElement[];
  const first = cards.indexOf(slides[0]);
  const previous = stage.querySelector<HTMLButtonElement>('[data-prev]')!;
  const following = stage.querySelector<HTMLButtonElement>('[data-next]')!;
  let slot = first;
  const rotate = feature.querySelector<HTMLButtonElement>('[data-rotate]')!;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let automatic = !reducedMotion.matches;
  let timer = 0;
  function schedule() {
    window.clearTimeout(timer);
    rotate.textContent = automatic ? 'Ⅱ' : '▶';
    rotate.title = automatic ? '暂停自动轮播' : '开启自动轮播';
    rotate.setAttribute('aria-label', rotate.title);
    if (!automatic || document.hidden || feature.hidden || feature.matches(':hover') || feature.contains(document.activeElement)) return;
    timer = window.setTimeout(()=>go(current+1),8000);
  }
  const wrap = (i: number) => (i + slides.length) % slides.length;
  function center(nextSlot: number) {
    cards[slot].inert = true;
    cards[slot].removeAttribute('aria-current');
    slot = nextSlot;
    cards[slot].inert = false;
    cards[slot].setAttribute('aria-current','true');
    track.style.setProperty('--offset',String(-slot));
  }
  function finishWrap() {
    if (slot === first + current) return;
    const focused = document.activeElement;
    const focusIndex = Array.from(cards[slot].querySelectorAll('a')).findIndex(a=>a===focused);
    track.removeAttribute('data-moving');
    center(first + current);
    // Commit the identical frame before the next animated step.
    void track.offsetWidth;
    if (focusIndex >= 0) cards[slot].querySelectorAll('a')[focusIndex]?.focus({preventScroll:true});
  }
  function go(next: number) {
    const target = wrap(next);
    if (current === target) return;
    finishWrap();
    let step = next - current;
    if (Math.abs(step) === slides.length-1 && Math.abs(step)>1) step = -Math.sign(step);
    track.setAttribute('data-moving','');
    center(slot + step);
    current = target;
    if (reducedMotion.matches) finishWrap();
    dots.forEach((b,i)=>{if(i===current) b.setAttribute('aria-current','true'); else b.removeAttribute('aria-current');});
    previous.setAttribute('aria-label','上一个项目：'+slides[wrap(current-1)].querySelector('h3')!.textContent);
    following.setAttribute('aria-label','下一个项目：'+slides[wrap(current+1)].querySelector('h3')!.textContent);
    schedule();
  }
  track.addEventListener('transitionend',e=>{
    if (e.target===track && e.propertyName==='transform') finishWrap();
  });
  rotate.addEventListener('click',()=>{automatic=!automatic; schedule();});
  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) { automatic = false; finishWrap(); schedule(); }
  });
  feature.addEventListener('pointerenter',()=>window.clearTimeout(timer));
  feature.addEventListener('pointerleave',schedule);
  feature.addEventListener('focusin',()=>window.clearTimeout(timer));
  feature.addEventListener('focusout',()=>queueMicrotask(schedule));
  document.addEventListener('visibilitychange',schedule);
  new MutationObserver(() => {
    if (feature.hidden) finishWrap();
    schedule();
  }).observe(feature,{attributes:true,attributeFilter:['hidden']});
  schedule();
  previous.addEventListener('click',()=>go(current-1));
  following.addEventListener('click',()=>go(current+1));
  dots.forEach((dot,i)=>dot.addEventListener('click',()=>go(i)));
  feature.addEventListener('keydown',e=>{
    if(e.key!=='ArrowLeft' && e.key!=='ArrowRight') return;
    e.preventDefault(); go(current+(e.key==='ArrowLeft'?-1:1)); dots[current].focus();
  });
  let start: {x:number;y:number}|undefined;
  stage.addEventListener('touchstart',e=>{
    const t=e.touches[0]; start=e.touches.length===1?{x:t.clientX,y:t.clientY}:undefined;
  },{passive:true});
  stage.addEventListener('touchcancel',()=>{start=undefined;});
  stage.addEventListener('touchmove', e => {
    if (!start || !e.cancelable) return;
    const dx = Math.abs(e.touches[0].clientX - start.x);
    const dy = Math.abs(e.touches[0].clientY - start.y);
    if (dx > 12 && dx > dy * 1.4) e.preventDefault();
  }, {passive:false});
  stage.addEventListener('touchend',e=>{
    if(!start) return;
    const t=e.changedTouches[0], dx=t.clientX-start.x, dy=t.clientY-start.y;
    if(Math.abs(dx)>45 && Math.abs(dx)>Math.abs(dy)*1.4) {
      if (e.cancelable) e.preventDefault();
      go(current+(dx<0?1:-1));
    }
    start=undefined;
  },{passive:false});
}

export function setupDiscovery() {
  const home=document.querySelector<HTMLElement>('.discover-home')!;
  const feature=home.querySelector<HTMLElement>('[data-featured]');
  if(feature) setupFeatured(feature);
  const box=home.querySelector<HTMLElement>('[data-project-search]')!;
  const input=box.querySelector<HTMLInputElement>('input')!;
  const clear=box.querySelector<HTMLButtonElement>('[data-clear]')!;
  const menu=box.querySelector<HTMLElement>('.search-menu')!;
  const links=Array.from(menu.querySelectorAll<HTMLAnchorElement>('[data-search]'));
  const board=home.querySelector<HTMLElement>('#projects')!;
  const tiles=Array.from(board.querySelectorAll<HTMLElement>('[data-project]'));
  const picks=tiles.filter(tile=>tile.hasAttribute('data-pick'));
  const status=home.querySelector<HTMLElement>('[data-search-status]')!;
  const pagination=home.querySelector<HTMLElement>('.project-pagination')!;
  const previousPage=pagination.querySelector<HTMLButtonElement>('[data-page-prev]')!;
  const nextPage=pagination.querySelector<HTMLButtonElement>('[data-page-next]')!;
  const pageLabel=pagination.querySelector<HTMLElement>('[data-page-label]')!;
  const heading=home.querySelector<HTMLElement>('#library-title')!;
  const arrows=board.querySelector<HTMLElement>('[data-board-arrows]')!;
  const previousGroup=arrows.querySelector<HTMLButtonElement>('[data-board-prev]')!;
  const nextGroup=arrows.querySelector<HTMLButtonElement>('[data-board-next]')!;
  const indicators=board.querySelector<HTMLElement>('[data-board-dots]')!;
  const dots=Array.from(indicators.querySelectorAll<HTMLButtonElement>('[data-board-dot]'));
  const groups=getBoardPageSizes(picks.length);
  const groupCount=groups.length;
  const positions={overview:0, search:0, all:0};
  let mode:keyof typeof positions='overview';
  let previousQuery='';
  let browseAll=false;
  let results=picks;

  function renderPage() {
    const overview=mode==='overview';
    const pageSize=10;
    const index=positions[mode];
    const pages=overview ? groupCount : Math.ceil(results.length/pageSize);
    const start=overview ? groups.slice(0,index).reduce((sum,size)=>sum+size,0) : index*pageSize;
    const visible=results.slice(start,start+(overview ? groups[index] ?? 0 : pageSize));
    board.dataset.boardMode=mode;
    if (overview) board.dataset.boardCount=String(visible.length);
    else delete board.dataset.boardCount;
    for (const tile of tiles) {
      const slot=visible.indexOf(tile);
      tile.hidden=slot<0;
      if (overview && slot>=0) tile.dataset.boardSlot=String(slot+1);
      else delete tile.dataset.boardSlot;
    }
    arrows.hidden=indicators.hidden=!overview || groupCount<=1;
    dots.forEach((dot,i)=>{
      if (i===positions.overview) dot.setAttribute('aria-current','true');
      else dot.removeAttribute('aria-current');
    });
    pagination.hidden=overview || pages<=1;
    previousPage.disabled=index===0;
    nextPage.disabled=index+1>=pages;
    pageLabel.textContent=`第 ${index+1} / ${pages} 页`;
  }
  function showGroup(target: number) {
    if (mode!=='overview' || groupCount<2) return;
    positions.overview=(target+groupCount)%groupCount;
    renderPage();
    status.textContent=`第 ${positions.overview+1} / ${groupCount} 组，共 ${picks.length} 个项目`;
  }
  previousGroup.addEventListener('click',()=>showGroup(positions.overview-1));
  nextGroup.addEventListener('click',()=>showGroup(positions.overview+1));
  dots.forEach((dot,i)=>dot.addEventListener('click',()=>showGroup(i)));
  board.addEventListener('keydown',e=>{
    const control=e.target;
    if (mode!=='overview' || groupCount<2 || !(control instanceof HTMLElement)) return;
    if (e.altKey || e.ctrlKey || e.metaKey || !['ArrowLeft','ArrowRight'].includes(e.key)) return;
    if (!control.closest('.board-stage,[data-board-dots]')) return;
    const fromTile=control.closest<HTMLElement>('[data-board-slot]');
    e.preventDefault();
    showGroup(positions.overview+(e.key==='ArrowRight'?1:-1));
    if (indicators.contains(control)) dots[positions.overview].focus();
    else if (fromTile) board.querySelector<HTMLElement>('[data-board-slot="1"] .tile-project-link')?.focus();
  });
  function turnPage(step: number) {
    positions[mode]+=step;
    renderPage();
    status.textContent=`${pageLabel.textContent}，共 ${results.length} 个项目`;
    heading.focus({preventScroll:true});
    heading.scrollIntoView({block:'nearest'});
  }
  previousPage.addEventListener('click',()=>turnPage(-1));
  nextPage.addEventListener('click',()=>turnPage(1));
  function update(open: boolean) {
    const query=input.value.trim().normalize('NFKC').toLocaleLowerCase();
    if (query!==previousQuery) positions.search=0;
    previousQuery=query;
    mode=query ? 'search' : browseAll ? 'all' : 'overview';
    results=query ? tiles.filter(tile=>tile.dataset.project!.includes(query)) : browseAll ? tiles : picks;
    const count=results.length;
    renderPage();
    clear.hidden=!query;
    if(feature) feature.hidden=Boolean(query);
    home.querySelector<HTMLElement>('[data-library-title]')!.textContent=query?'项目搜索结果':browseAll?'全部项目':'近期好评项目';
    home.querySelector<HTMLElement>('[data-result-count]')!.textContent=String(count);
    home.querySelector<HTMLElement>('[data-empty]')!.hidden=!query || count!==0;
    home.querySelector<HTMLElement>('[data-no-picks]')!.hidden=Boolean(query) || count!==0;
    home.querySelector<HTMLElement>('.ranking-rule')!.hidden=mode!=='overview';
    home.querySelector<HTMLElement>('[data-back-to-picks]')!.hidden=mode!=='all';
    const matches=links.filter(link=>link.dataset.search!.includes(query));
    // Prefer direct company or project name matches over a project matched via its parent company.
    const rank=(link:HTMLAnchorElement)=>{
      const name=link.dataset.name!.toLocaleLowerCase();
      if(name===query) return 0;
      if(name.startsWith(query)) return 1;
      if(name.includes(query)) return 2;
      return link.dataset.kind==='公司'?3:4;
    };
    matches.sort((a,b)=>rank(a)-rank(b));
    links.forEach(l=>{l.hidden=true;});
    matches.forEach(l=>{l.hidden=false;menu.append(l);});
    menu.querySelector<HTMLElement>('[data-no-suggestions]')!.hidden=matches.length!==0;
    menu.hidden=!query || !open;
    status.textContent=query?`匹配到 ${count} 个项目`:'';
  }
  const visibleLinks=()=>Array.from(menu.querySelectorAll<HTMLAnchorElement>('a:not([hidden])'));
  function reset(){input.value=''; update(false); input.focus();}
  clear.addEventListener('click',reset);
  home.querySelector('[data-reset]')!.addEventListener('click',()=>{
    browseAll=true; positions.all=0; input.value=''; update(false); heading.focus();
  });
  home.querySelector('[data-back-to-picks]')!.addEventListener('click',()=>{
    browseAll=false; update(false); heading.focus();
  });
  input.addEventListener('input',()=>update(true));
  input.addEventListener('focus',()=>update(true));
  box.addEventListener('keydown',e=>{
    if(e.isComposing)return;
    if(e.key==='Escape'){e.preventDefault();input.focus();menu.hidden=true;return;}
    if(e.key==='Enter' && e.target===input && input.value.trim()){
      const first=visibleLinks()[0];if(first){e.preventDefault();first.click();}return;
    }
    if(!input.value.trim() || !['ArrowDown','ArrowUp'].includes(e.key))return;
    e.preventDefault();menu.hidden=false;
    const options=visibleLinks();if(!options.length)return;
    const i=options.indexOf(document.activeElement as HTMLAnchorElement);
    const next=e.key==='ArrowDown'?(i+1)%options.length:(i<=0?options.length-1:i-1);
    options[next].focus();
  });
  box.addEventListener('focusout',e=>{if(!box.contains(e.relatedTarget as Node|null))menu.hidden=true;});
  document.addEventListener('pointerdown',e=>{if(!box.contains(e.target as Node))menu.hidden=true;});
  update(false);
}
