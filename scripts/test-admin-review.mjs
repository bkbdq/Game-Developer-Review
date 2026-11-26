#!/usr/bin/env node
/**
 * 审核台 M4·P0 单测（零依赖，node scripts/test-admin-review.mjs）。
 * 覆盖：敏感信息检测、相似内容对比、匿名项目数据契约。
 */
import {
  scanText,
  scanDraft,
  highlightRanges,
} from '../admin/lib/sensitive.js';
import { similarity, findSimilar } from '../admin/lib/similar.js';
import { buildReview, validateDraft } from '../admin/lib/review.js';
import {
  parseAliases,
  composeReview,
  reviewContentChanged,
  referencedProjectIds,
  composeCompany,
  companyContentChanged,
  newProjectId,
} from '../admin/lib/published.js';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const key = value => Array.isArray(value) ? JSON.stringify(value) : value;
  const ok = typeof expected === 'boolean' ? actual === expected : Object.is(key(actual), key(expected));
  if (ok) passed += 1;
  else failures.push(`${name}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

function types(hits, level) {
  return hits.filter(hit => hit.level === level).map(hit => hit.type).sort();
}

// ── 敏感信息检测（FE-2） ──────────────────────────────────────────────────
check('手机号纯数字', types(scanText('联系我 13812345678 谢谢'), 'hard'), ['手机号']);
check('手机号带空格', types(scanText('电话 138 1234 5678'), 'hard'), ['手机号']);
check('手机号带横线', types(scanText('138-1234-5678'), 'hard'), ['手机号']);
check('非手机号不误报', scanText('我们组大概 15 个人，2024 年成立的').filter(hit => hit.level === 'hard').length, 0);
check('邮箱', types(scanText('发简历到 name@example.com'), 'hard'), ['邮箱']);
check('身份证 18 位', types(scanText('身份证 110105194912310021'), 'hard'), ['身份证号']);
check('身份证 X 结尾', types(scanText('11010519491231002X'), 'hard'), ['身份证号']);
check('微信号提醒', types(scanText('加微信 wx_zhang123 细聊'), 'soft'), ['微信号 / QQ']);
check('QQ 号提醒', types(scanText('QQ: 123456789'), 'soft'), ['微信号 / QQ']);
check('住址提醒', types(scanText('公司在高新区天府大道 200 号写字楼'), 'soft'), ['疑似住址']);
check('门牌提醒', types(scanText('就在 3 号楼上班'), 'soft'), ['疑似住址']);
check('普通文字无命中', scanText('项目节奏很快，同事都很好，推荐来').length, 0);

const draft = scanDraft({ comment: '找我 13812345678', title: 'mail: a@b.com' });
check('scanDraft 汇总命中数', draft.hits.length, 2);
check('scanDraft 字段标注', draft.hits[1].field, '标题');
check('scanDraft 硬拦截标记', draft.hasHard, true);

const previewHits = scanDraft({ comment: '电话13812345678和a@b.com', title: '' });
const ranges = highlightRanges(previewHits.hits, previewHits.hits.length && 17);
check('高亮区间合并', ranges.length, 2);
check('高亮不越界', ranges[ranges.length - 1].end, 17);

// ── 相似内容（FE-3） ─────────────────────────────────────────────────────
check('完全一致 = 1', similarity('这家公司加班很严重', '这家公司加班很严重'), 1);
check('小改动仍高相似', similarity('这家公司加班很严重，管理混乱', '这家公司加班很严重，管理混乱。') > 0.9, true);
check('无关文本低相似', similarity('这家公司加班很严重', '食堂好吃福利多') < 0.3, true);
check('空文本 = 0', similarity('', 'abc'), 0);

const candidates = [
  { id: 'rv_a', text: '这家公司加班很严重，长期十点后下班' },
  { id: 'rv_b', text: '食堂好吃，福利多' },
];
const hits = findSimilar('这家公司加班很严重，长期十点后下班', candidates, { threshold: 0.75 });
check('相似命中第一条', hits[0]?.item.id, 'rv_a');
check('相似度排序', findSimilar('食堂好吃福利多，加班少', candidates)[0]?.item.id, 'rv_b');
check('无相似返回空', findSimilar('完全不同的内容说的是别的公司', candidates).length, 0);

// ── 匿名项目契约（FE-5） ────────────────────────────────────────────────
const anonReview = buildReview({
  id: 'rv_test1', companyId: 'c_x', projectId: '', projectAnonymous: true,
  score: 4, comment: '不错', profile: {}, tags: [], publishedAt: '2026-11-21',
});
check('匿名评价无 projectId', anonReview.projectId, undefined);
check('匿名评价有标记', anonReview.projectAnonymous, true);

const normalReview = buildReview({
  id: 'rv_test2', companyId: 'c_x', projectId: 'p_x', projectAnonymous: false,
  score: 4, comment: '不错', profile: {}, tags: [], publishedAt: '2026-11-21',
});
check('普通评价保留 projectId', normalReview.projectId, 'p_x');
check('普通评价无标记', normalReview.projectAnonymous, undefined);

const taxonomy = {
  roles: [{ key: 'design', label: '策划' }],
  tenures: [{ key: 'lt1y', label: '1 年以内' }, { key: '1-3y', label: '1–3 年' }, { key: '3-5y', label: '3–5 年' }, { key: 'gt5y', label: '5 年以上' }],
  employments: [{ key: 'current', label: '在职' }],
  cities: [{ key: 'beijing', label: '北京' }],
  tags: [{ key: 'overtime', label: '加班' }],
};
const company = { projects: [{ id: 'p_x' }] };
check('匿名+projectId 冲突报错', validateDraft(
  { companyId: 'c_x', projectId: 'p_x', projectAnonymous: true, score: 3, comment: 'ok', publishedAt: '2026-11-21', profile: { tenure: 'lt1y' }, tags: [] },
  { taxonomy, company }).some(message => message.includes('匿名项目')), true);
check('在职时长四区间通过', validateDraft(
  { companyId: 'c_x', projectId: '', projectAnonymous: true, score: 3, comment: 'ok', publishedAt: '2026-11-21', profile: { tenure: 'gt5y' }, tags: [] },
  { taxonomy, company }).length, 0);
check('非法时长报错', validateDraft(
  { companyId: 'c_x', projectId: '', projectAnonymous: true, score: 3, comment: 'ok', publishedAt: '2026-11-21', profile: { tenure: 'abc' }, tags: [] },
  { taxonomy, company }).some(message => message.includes('司龄')), true);

// ── 已展示数据修正 ───────────────────────────────────────────────────────
check('别名中英文逗号拆分去重', parseAliases('米哈游，miHoYo, 米哈游\n'), ['米哈游', 'miHoYo']);

const publishedOriginal = {
  schemaVersion: 1,
  id: 'rv_pub1',
  companyId: 'c_x',
  projectId: 'p_x',
  score: 3,
  title: '旧标题',
  comment: '旧正文',
  profile: { tenure: 'lt1y', role: 'program' },
  tags: ['overtime'],
  publishedAt: '2026-11-01',
  revision: 1,
};
const publishedNext = composeReview(publishedOriginal, {
  score: 4,
  title: '',
  comment: '新正文',
  projectId: '',
  projectAnonymous: true,
  tenure: '1-3y',
  tags: ['management'],
  publishedAt: '2026-11-02',
});
check('修正递增 revision', publishedNext.revision, 2);
check('修正为匿名项目移除 projectId', publishedNext.projectId, undefined);
check('修正为匿名项目写入标记', publishedNext.projectAnonymous, true);
check('修正清空标题', publishedNext.title, undefined);
check('修正保留画像其他字段', publishedNext.profile.role, 'program');
check('修正更新在职时长', publishedNext.profile.tenure, '1-3y');
check('修正替换标签', JSON.stringify(publishedNext.tags), JSON.stringify(['management']));
check('内容变化可识别', reviewContentChanged(publishedOriginal, publishedNext), true);
check('仅 revision 变化不算改动', reviewContentChanged(publishedOriginal, { ...publishedOriginal, revision: 9 }), false);

const publishedProject = composeReview(publishedOriginal, {
  score: 3,
  title: '旧标题',
  comment: '旧正文',
  projectId: 'p_y',
  projectAnonymous: false,
  tenure: 'lt1y',
  tags: ['overtime'],
  publishedAt: '2026-11-01',
});
check('修正项目保留 projectId', publishedProject.projectId, 'p_y');
check('修正项目移除匿名标记', publishedProject.projectAnonymous, undefined);

check('引用项目去重', [...referencedProjectIds([
  { projectId: 'p_x' }, { projectId: 'p_x' }, {}, { projectId: 'p_y' },
])].sort(), ['p_x', 'p_y']);

const companyOriginal = {
  schemaVersion: 1,
  id: 'c_x',
  slug: 'x',
  name: '旧名',
  aliases: ['别名'],
  projects: [{ id: 'p_x', name: '项目', status: 'live', genre: 'rpg' }],
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};
const companyNext = composeCompany(companyOriginal, {
  name: '新名',
  slug: 'x-new',
  aliases: ['别名', '新别名'],
  projects: [
    { id: 'p_x', name: '项目改名', status: 'dev', genre: 'rpg' },
    { id: 'p_y', name: '新项目', status: 'unknown' },
  ],
}, '2026-11-26');
check('公司更新名称与 slug', [companyNext.name, companyNext.slug], ['新名', 'x-new']);
check('公司项目保留扩展字段', companyNext.projects[0].genre, 'rpg');
check('公司 updatedAt 更新', companyNext.updatedAt, '2026-11-26');
check('公司仅 updatedAt 变化不算改动', companyContentChanged(companyOriginal, { ...companyOriginal, updatedAt: '2026-11-26' }), false);
check('公司内容变化可识别', companyContentChanged(companyOriginal, companyNext), true);

const generatedId = newProjectId('测试项目', new Set());
check('新项目 ID 以 p_ 开头', generatedId.startsWith('p_'), true);
check('项目 ID 冲突追加序号', newProjectId('测试项目', new Set([generatedId])), `${generatedId}-2`);

if (failures.length) {
  console.error(`✗ ${failures.length} 项失败：`);
  failures.forEach(line => console.error(`  - ${line}`));
  process.exit(1);
}
console.log(`✓ 审核台 M4·P0 测试全部通过（${passed} 项）`);
