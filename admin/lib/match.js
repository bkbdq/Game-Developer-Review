/**
 * 模糊匹配核心：归一化、评分、排序、别名索引。
 * 评分含义：100 完全一致，90 前缀命中，80 包含命中，70–85 容错（错别字）。
 * 供审核控制台做公司 / 项目自动匹配与搜索，纯函数，可在 Node 中单测。
 */

/** 自动匹配的最低可信分（错别字容错线）。 */
export const AUTO_MATCH_THRESHOLD = 75;

/** 归一化：全角转半角、小写、去掉空白与标点，只保留字母数字与表意文字。 */
const NON_WORD = /[^\p{L}\p{N}]+/gu;

export function normalize(text) {
  return String(text ?? '').normalize('NFKC').toLowerCase().replace(NON_WORD, '');
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const curr = [i];
    for (let j = 1; j <= b.length; j += 1) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/**
 * 给查询单词与候选词打分；不相关返回 0。
 * 单字查询不做包含 / 容错匹配，避免搜索列表噪声。
 */
export function scoreMatch(query, candidate) {
  const q = normalize(query);
  const c = normalize(candidate);
  if (!q || !c) return 0;
  if (q === c) return 100;
  const min = Math.min(q.length, c.length);
  if (min >= 2 && (c.startsWith(q) || q.startsWith(c))) return 90;
  if (min >= 2 && (c.includes(q) || q.includes(c))) return 80;
  const distance = levenshtein(q, c);
  const sim = 1 - distance / Math.max(q.length, c.length);
  if (min >= 3 && sim >= 0.6) return Math.round(55 + sim * 30);
  if (min === 2 && distance === 1) return 70;
  return 0;
}

/**
 * 在一组检索键中取最高分。键是字符串或 { k, ...tag } 对象，返回最高分的键原对象。
 */
export function bestKeyScore(query, keys) {
  let best = { score: 0, key: null };
  for (const key of keys || []) {
    const text = typeof key === 'string' ? key : key?.k;
    if (!text) continue;
    const score = scoreMatch(query, text);
    if (score > best.score) best = { score, key };
  }
  return best;
}

/**
 * 给可搜索下拉排序：query 为空时按原顺序返回全部（不裁剪超过 limit 也无所谓），
 * 否则按分数降序，返回 { option, score, key }。
 */
export function rankOptions(query, options, { limit = 40 } = {}) {
  const entries = (options || []).map(option => {
    const { score, key } = bestKeyScore(query, option.keys?.length ? option.keys : [option.label]);
    return { option, score, key };
  }).filter(entry => entry.score > 0);
  entries.sort((a, b) =>
    b.score - a.score ||
    String(a.option.label).localeCompare(String(b.option.label), 'zh-CN'));
  return entries.slice(0, limit);
}

/** 库名与公司名互相匹配才挂接别名，避免张冠李戴。 */
const LINK_THRESHOLD = 80;

/**
 * 把内置别名库映射到公开仓的公司数据上，生成每个公司 / 项目的补充检索键。
 * 返回 Map<companyId, { aliases, projects: Map<projectId, string[]>, extra }>
 * - aliases：库名能对上该公司时，把库里的公司别名并入。
 * - projects：库里项目名能对上该公司现有项目时，把项目别名并入。
 * - extra：库里项目归属该公司但数据里还没建项目，留作提示。
 */
export function buildAliasIndex(companies, library) {
  const index = new Map();
  for (const company of companies.values()) {
    index.set(company.id, { aliases: [], projects: new Map(), extra: [] });
  }
  const lib = library || {};
  for (const entry of lib.companies || []) {
    if (!entry?.name) continue;
    for (const company of companies.values()) {
      if (scoreMatch(entry.name, company.name) < LINK_THRESHOLD) continue;
      index.get(company.id).aliases.push(...(entry.aliases || []));
    }
  }
  for (const project of lib.projects || []) {
    if (!project?.name || !project.company) continue;
    for (const company of companies.values()) {
      if (scoreMatch(project.company, company.name) < LINK_THRESHOLD) continue;
      const node = index.get(company.id);
      let linked = false;
      for (const own of company.projects || []) {
        if (scoreMatch(project.name, own.name) >= LINK_THRESHOLD) {
          const keys = node.projects.get(own.id) || [];
          node.projects.set(own.id, [...keys, ...(project.aliases || [])]);
          linked = true;
        }
      }
      if (!linked) node.extra.push({ name: project.name, aliases: project.aliases || [] });
    }
  }
  return index;
}
