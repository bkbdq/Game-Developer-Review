/**
 * 极简 DOM 构建助手，供 app.js 与 combo.js 共用。
 */
export function h(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  Object.entries(attrs).forEach(([key, value]) => {
    if (key === 'class') element.className = value;
    else if (key === 'dataset') Object.assign(element.dataset, value);
    else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in element) element[key] = value;
    else element.setAttribute(key, value);
  });
  children.flat().forEach(child => {
    if (child === null || child === undefined || child === false) return;
    element.append(child.nodeType ? child : document.createTextNode(String(child)));
  });
  return element;
}
