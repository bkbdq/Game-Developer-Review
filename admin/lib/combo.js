import { h } from './dom.js';
import { normalize, rankOptions } from './match.js';

/**
 * 可搜索下拉组合框。视觉上是一个输入框，聚焦或输入时弹出按模糊分数排序的候选列表。
 * 选项结构：{ value, label, sub?, keys? }，keys 为检索键数组（字符串或 { k, ...标记 }）。
 * 通过 onSelect(value, { query, project }) / onBlur(text) 两个回调接业务语义。
 */
export function createCombobox({ input, list, limit = 40, onSelect, onBlur }) {
  const api = { value: '' };
  let options = [];
  let entries = [];
  let activeIndex = 0;
  let open = false;
  let display = '';

  function close() {
    open = false;
    activeIndex = 0;
    list.hidden = true;
    list.replaceChildren();
  }

  function tag(entry) {
    if (entry.key?.project !== undefined && entry.key?.pn) return `项目「${entry.key.pn}」`;
    return '';
  }

  function updateActive() {
    [...list.children].forEach((child, index) => child.classList.toggle('active', index === activeIndex));
    list.children[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }

  function render(query) {
    entries = rankOptions(query, options, { limit });
    if (!entries.length) {
      list.replaceChildren(h('div', { class: 'combo-empty' }, '没有匹配项'));
    } else {
      list.replaceChildren(...entries.map((entry, index) => {
        const sub = [entry.option.sub, tag(entry)].filter(Boolean).join(' · ');
        return h('button', {
          type: 'button',
          class: 'combo-item' + (index === activeIndex ? ' active' : ''),
          // pointerdown 阻止默认行为，输入框不会先失焦，列表也就不会被提前收起
          onPointerdown: event => { event.preventDefault(); choose(index); },
        },
          h('span', { class: 'combo-label' }, entry.option.label),
          h('span', { class: 'combo-sub' }, sub || ' '),
        );
      }));
    }
    open = true;
    list.hidden = false;
  }

  function choose(index) {
    const entry = entries[index];
    if (!entry) return;
    const query = input.value;
    api.value = entry.option.value;
    display = entry.option.label;
    input.value = display;
    close();
    onSelect?.(entry.option.value, { query, project: entry.key?.project ?? null, projectName: entry.key?.pn ?? '' });
  }

  input.addEventListener('input', () => {
    activeIndex = 0;
    render(input.value);
  });
  input.addEventListener('focus', () => render(input.value));
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) render(input.value);
      if (!entries.length) return;
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = (activeIndex + delta + entries.length) % entries.length;
      updateActive();
    } else if (event.key === 'Enter') {
      // 输入框在审核表单里，拦截回车避免误触「通过并发布」
      event.preventDefault();
      if (open && entries.length) choose(activeIndex);
    } else if (event.key === 'Escape' && open) {
      event.stopPropagation();
      input.value = display;
      close();
    }
  });
  input.addEventListener('blur', () => {
    // 候选点击已被 pointerdown preventDefault 拦下，走到这里的都是真失焦
    setTimeout(() => {
      if (!open) return;
      close();
      onBlur?.(input.value);
    }, 0);
  });

  api.setOptions = next => {
    options = next || [];
    if (open) render(input.value);
  };

  api.setValue = (value, text) => {
    api.value = value;
    const option = options.find(item => item.value === value);
    display = text !== undefined ? text : (option?.label ?? '');
    input.value = display;
    close();
  };

  api.labelOf = value => options.find(item => item.value === value)?.label || '';

  return api;
}
