#!/usr/bin/env node
/**
 * 审核控制台模糊匹配与别名库的单测（零依赖，node scripts/test-admin-match.mjs）。
 * 覆盖：归一化、评分、搜索排序、别名库映射，以及别名库自身的一致性。
 */
import { readFileSync } from 'node:fs';
import {
  normalize,
  scoreMatch,
  bestKeyScore,
  rankOptions,
  buildAliasIndex,
  AUTO_MATCH_THRESHOLD,
} from '../admin/lib/match.js';

const library = JSON.parse(readFileSync(new URL('../admin/lib/aliases.json', import.meta.url), 'utf8'));

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  const ok = typeof expected === 'boolean' ? actual === expected : Object.is(actual, expected);
  if (ok) passed += 1;
  else failures.push(`${name}：期望 ${expected}，实际 ${actual}`);
}

function checkTruthy(name, actual) {
  if (actual) passed += 1;
  else failures.push(`${name}：期望真值，实际 ${actual}`);
}

// ── 归一化 ────────────────────────────────────────────────────────────────
check('normalize 全角标点', normalize('崩坏：星穹铁道'), '崩坏星穹铁道');
check('normalize 大小写空格', normalize('  Zenless Zone Zero '), 'zenlesszonezero');
check('normalize 中文不变', normalize('米哈游'), '米哈游');

// ── 评分 ──────────────────────────────────────────────────────────────────
check('完全一致 100', scoreMatch('ZZZ', 'zzz'), 100);
check('前缀命中 90', scoreMatch('王者', '王者荣耀'), 90);
check('查询以候选开头 90', scoreMatch('米哈游网络科技', '米哈游'), 90);
check('候选以查询开头 90', scoreMatch('米哈', '米哈游'), 90);
check('三字错别字 ≥75', scoreMatch('米哈油', '米哈游') >= AUTO_MATCH_THRESHOLD, true);
check('两字错别字 70', scoreMatch('鹰洛', '鹰角'), 70);
check('无关为 0', scoreMatch('企鹅', '米哈游'), 0);
check('单字不包含匹配', scoreMatch('米', '米哈游'), 0);
check('数字别名 1999', scoreMatch('1999', '重返未来:1999'), 80);

// ── 检索键 ────────────────────────────────────────────────────────────────
const keyHit = bestKeyScore('zzz', [{ k: '米哈游' }, { k: 'ZZZ', project: 'p_1', pn: '绝区零' }]);
check('键取最高分', keyHit.score, 100);
check('键带出项目', keyHit.key?.pn, '绝区零');

// ── 别名库映射 ────────────────────────────────────────────────────────────
const companies = new Map([
  ['c_mihoyo', { id: 'c_mihoyo', name: '米哈游', slug: 'mihoyo', aliases: [], projects: [{ id: 'p_zzz', name: '绝区零' }] }],
  ['c_abc', { id: 'c_abc', name: '某某小厂', slug: 'abc', aliases: [], projects: [] }],
]);
const index = buildAliasIndex(companies, library);
const mihoyo = index.get('c_mihoyo');
checkTruthy('库公司别名并入', mihoyo.aliases.includes('米哈油'));
checkTruthy('库项目别名并入现有项目', mihoyo.projects.get('p_zzz')?.includes('ZZZ'));
const abc = index.get('c_abc');
check('无关公司不受污染', abc.aliases.length, 0);

// ── 搜索排序 ──────────────────────────────────────────────────────────────
const options = [...companies.values()].map(company => {
  const node = index.get(company.id);
  return {
    value: company.id,
    label: company.name,
    keys: [
      { k: company.name },
      ...node.aliases.map(k => ({ k })),
      ...[...node.projects.entries()].flatMap(([id, aliases]) => aliases.map(k => ({ k, project: id, pn: '绝区零' }))),
    ],
  };
});
const ranked = rankOptions('zzz', options);
check('搜索 ZZZ 命中公司数', ranked.length, 1);
check('搜索 ZZZ 命中公司', ranked[0]?.option.label, '米哈游');
check('搜索 ZZZ 标注项目', ranked[0]?.key?.pn, '绝区零');
const rankedTypo = rankOptions('米哈油', options);
check('错别字搜索命中', rankedTypo[0]?.option.label, '米哈游');
const rankedNone = rankOptions('企鹅', options);
check('无关搜索为空', rankedNone.length, 0);

// ── 别名库一致性 ──────────────────────────────────────────────────────────
const companyNames = new Set(library.companies.map(entry => entry.name));
check('公司名无重复', companyNames.size, library.companies.length);
for (const entry of library.companies) {
  checkTruthy(`公司 ${entry.name} 的 aliases 是数组`, Array.isArray(entry.aliases));
}
for (const entry of library.projects) {
  checkTruthy(`项目 ${entry.name} 的 aliases 是数组`, Array.isArray(entry.aliases));
  if (entry.company) {
    checkTruthy(`项目 ${entry.name} 的归属 ${entry.company} 在公司列表中`, companyNames.has(entry.company));
  }
}
checkTruthy('绝区零有 ZZZ 别名', library.projects.find(entry => entry.name === '绝区零')?.aliases.includes('ZZZ'));
checkTruthy('绝区零归属米哈游', library.projects.find(entry => entry.name === '绝区零')?.company === '米哈游');

if (failures.length) {
  console.error(`✗ ${failures.length} 项失败：`);
  failures.forEach(line => console.error(`  - ${line}`));
  process.exit(1);
}
console.log(`✓ 匹配与别名库测试全部通过（${passed} 项）`);
