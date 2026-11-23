/**
 * 敏感信息检测（M4·FE-2）。
 * 硬拦截（标红、禁止发布）：手机号、邮箱、身份证号
 * 软提醒（黄色）：微信号 / QQ、疑似住址
 * 只扫描会公开的字段（正文、标题）；返回按位置排序的命中列表。
 */

const RULES = [
  { type: '手机号', level: 'hard', re: /(?<!\d)1[3-9](?:[ -]?\d){9}(?!\d)/g },
  { type: '邮箱', level: 'hard', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  { type: '身份证号', level: 'hard', re: /(?<!\d)\d{17}[\dXx](?!\d)/g },
  { type: '疑似住址', level: 'soft', re: /[\u4e00-\u9fa5]{1,12}(?:路|街|巷|大道|大街)[\u4e00-\u9fa5\d\s]{0,10}?\d{1,5}\s*号|\d{1,4}\s*(?:号楼|号院|栋|幢|单元|室)/g },
  { type: '微信号 / QQ', level: 'soft', re: /(?:微信号|微信|加微|加v|加V|\+v|\+V|vx号?|v信|威信|扣扣|企鹅|qq|QQ)\s*[:：号]?\s*[a-zA-Z0-9_-]{4,20}/g },
];

/** 扫描一段文本，返回 [{ type, level, fragment, start, end }]（按出现位置排序）。 */
export function scanText(text) {
  const source = String(text || '');
  const hits = [];
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, 'g');
    let match;
    while ((match = re.exec(source))) {
      if (!match[0]) break;
      hits.push({
        type: rule.type,
        level: rule.level,
        fragment: match[0],
        start: match.index,
        end: match.index + match[0].length,
      });
    }
  }
  return hits.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * 扫描评价草稿的公开字段，返回 { hits, hasHard, hasSoft }。
 */
export function scanDraft({ comment = '', title = '' } = {}) {
  const hits = [...scanText(comment).map(hit => ({ ...hit, field: '正文' })),
    ...scanText(title).map(hit => ({ ...hit, field: '标题' }))]
    .sort((a, b) => (a.field === b.field ? a.start - b.start : a.field === '正文' ? -1 : 1));
  return {
    hits,
    hasHard: hits.some(hit => hit.level === 'hard'),
    hasSoft: hits.some(hit => hit.level === 'soft'),
  };
}

/**
 * 把命中片段转成高亮区间（合并重叠，hard 优先保留），
 * 供正文预览标红用：返回 [{ start, end, level }]。
 */
export function highlightRanges(hits, length) {
  const ranges = hits
    .filter(hit => hit.field !== '标题')
    .slice()
    .sort((a, b) => a.start - b.start || b.end - a.end || (a.level === 'hard' ? -1 : 1));
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start < last.end) {
      if (range.level === 'hard' && last.level !== 'hard') {
        last.end = Math.max(last.end, range.end);
        last.level = 'hard';
      }
      continue;
    }
    merged.push({ start: Math.max(0, range.start), end: Math.min(length, range.end), level: range.level });
  }
  return merged.filter(range => range.end > range.start);
}
