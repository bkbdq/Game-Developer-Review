import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, 'data');
const errors = [];

const fail = message => errors.push(message);
const isString = value => typeof value === 'string';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDate = value => isString(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const isInteger = value => Number.isInteger(value);

const BANNED_KEYS = new Set([
  'email', 'phone', 'mobile', 'ip', 'iphash', 'ua', 'useragent', 'token',
  'password', 'reviewer', 'auditor', 'rejectreason', 'contact',
]);
const SENSITIVE_PATTERNS = [
  { name: '邮箱', pattern: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { name: '手机号', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { name: '身份证号', pattern: /(?<!\d)\d{17}[\dXx](?!\d)/ },
];

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label}：无法解析 JSON（${error.message}）`);
    return null;
  }
}

function checkKeys(object, allowed, label) {
  Object.keys(object).forEach(key => {
    if (!allowed.includes(key)) fail(`${label}：未知字段 ${key}`);
    if (BANNED_KEYS.has(key.toLowerCase())) fail(`${label}：禁止出现字段 ${key}`);
  });
}

function checkSensitiveText(text, label) {
  SENSITIVE_PATTERNS.forEach(({ name, pattern }) => {
    if (pattern.test(text)) fail(`${label}：疑似包含${name}`);
  });
}

function checkEntries(entries, label) {
  if (!Array.isArray(entries)) return fail(`${label}：必须是数组`);
  const keys = new Set();
  entries.forEach((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    if (!isObject(entry)) return fail(`${itemLabel}：必须是对象`);
    checkKeys(entry, ['key', 'label'], itemLabel);
    if (!isString(entry.key) || !/^[a-z0-9_-]+$/.test(entry.key)) fail(`${itemLabel}：key 不合法`);
    if (!isString(entry.label) || !entry.label.trim()) fail(`${itemLabel}：label 不能为空`);
    if (keys.has(entry.key)) fail(`${itemLabel}：key 重复 ${entry.key}`);
    keys.add(entry.key);
  });
  return keys;
}

function validateTaxonomy() {
  const taxonomy = readJson(join(dataDir, 'taxonomy.json'), 'taxonomy.json');
  if (!taxonomy) return null;
  if (taxonomy.schemaVersion !== 1) fail('taxonomy.json：schemaVersion 必须为 1');
  checkKeys(taxonomy, ['schemaVersion', 'roles', 'tenures', 'employments', 'cities', 'tags'], 'taxonomy.json');
  const result = {};
  ['roles', 'tenures', 'employments', 'cities', 'tags'].forEach(dim => {
    result[dim] = checkEntries(taxonomy[dim], `taxonomy.json.${dim}`) || new Set();
  });
  return result;
}

function validateCompany(fileName) {
  const label = `data/companies/${fileName}`;
  const company = readJson(join(dataDir, 'companies', fileName), label);
  if (!company) return null;
  if (company.schemaVersion !== 1) fail(`${label}：schemaVersion 必须为 1`);
  checkKeys(company, ['schemaVersion', 'id', 'slug', 'name', 'aliases', 'projects', 'createdAt', 'updatedAt'], label);
  if (!/^c_[a-z0-9_-]+$/.test(company.id || '')) fail(`${label}：id 不合法`);
  if (fileName !== company.id + '.json') fail(`${label}：文件名必须与 id 一致`);
  if (!/^[a-z0-9-]+$/.test(company.slug || '')) fail(`${label}：slug 不合法`);
  if (!isString(company.name) || !company.name.trim() || company.name.length > 50) fail(`${label}：name 不合法`);
  if (company.aliases !== undefined) {
    if (!Array.isArray(company.aliases) || company.aliases.some(alias => !isString(alias) || !alias.trim())) {
      fail(`${label}：aliases 必须是非空字符串数组`);
    }
  }
  if (!isDate(company.createdAt)) fail(`${label}：createdAt 不合法`);
  if (!isDate(company.updatedAt)) fail(`${label}：updatedAt 不合法`);
  if (!Array.isArray(company.projects)) fail(`${label}：projects 必须是数组`);
  const projectIds = new Set();
  (company.projects || []).forEach((project, index) => {
    const projectLabel = `${label}.projects[${index}]`;
    if (!isObject(project)) return fail(`${projectLabel}：必须是对象`);
    checkKeys(project, ['id', 'name', 'status', 'genre', 'featuredReviewId'], projectLabel);
    if (project.featuredReviewId !== undefined && !/^rv_[A-Za-z0-9]+$/.test(project.featuredReviewId)) fail(`${projectLabel}：精选评价 ID 不合法`);
    if (!/^p_[a-z0-9_-]+$/.test(project.id || '')) fail(`${projectLabel}：id 不合法`);
    if (projectIds.has(project.id)) fail(`${projectLabel}：id 重复 ${project.id}`);
    projectIds.add(project.id);
    if (!isString(project.name) || !project.name.trim() || project.name.length > 50) fail(`${projectLabel}：name 不合法`);
    if (!['live', 'dev', 'cancelled', 'unknown'].includes(project.status)) fail(`${projectLabel}：status 不合法`);
    if (project.genre !== undefined && !isString(project.genre)) fail(`${projectLabel}：genre 必须是字符串`);
  });
  return { company, projectIds };
}

function validateReview(fileName, companyId, company, taxonomy, seenIds) {
  const label = `data/reviews/${companyId}/${fileName}`;
  const review = readJson(join(dataDir, 'reviews', companyId, fileName), label);
  if (!review) return;
  if (review.schemaVersion !== 1) fail(`${label}：schemaVersion 必须为 1`);
  checkKeys(review, [
    'schemaVersion', 'id', 'companyId', 'projectId', 'projectAnonymous', 'score', 'title',
    'comment', 'profile', 'tags', 'publishedAt', 'revision',
  ], label);
  if (!/^rv_[A-Za-z0-9]+$/.test(review.id || '')) fail(`${label}：id 不合法`);
  if (fileName !== review.id + '.json') fail(`${label}：文件名必须与 id 一致`);
  if (seenIds.has(review.id)) fail(`${label}：评价 id 重复 ${review.id}`);
  seenIds.add(review.id);
  if (review.companyId !== companyId) fail(`${label}：companyId 必须与目录一致`);
  if (review.projectAnonymous !== undefined && review.projectAnonymous !== true) {
    fail(`${label}：projectAnonymous 只能为 true`);
  }
  if (review.projectAnonymous && review.projectId !== undefined) {
    fail(`${label}：匿名项目评价不能同时关联 projectId`);
  }
  if (review.projectId !== undefined && !company.projectIds.has(review.projectId)) {
    fail(`${label}：projectId ${review.projectId} 不存在于公司项目列表`);
  }
  if (!isInteger(review.score) || review.score < 1 || review.score > 5) fail(`${label}：score 必须是 1–5 的整数`);
  if (review.title !== undefined) {
    if (!isString(review.title) || !review.title.trim() || review.title.length > 40) fail(`${label}：title 不合法`);
  }
  if (!isString(review.comment) || !review.comment.trim()) fail(`${label}：comment 不能为空`);
  else if (review.comment.length > 2000) fail(`${label}：comment 超过 2000 字`);
  if (review.profile !== undefined) {
    if (!isObject(review.profile)) fail(`${label}：profile 必须是对象`);
    else {
      checkKeys(review.profile, ['role', 'tenure', 'employment', 'city'], `${label}.profile`);
      Object.entries(review.profile).forEach(([dim, key]) => {
        const dictionary = { role: 'roles', tenure: 'tenures', employment: 'employments', city: 'cities' }[dim];
        if (!taxonomy[dictionary].has(key)) fail(`${label}：profile.${dim} 的值 ${key} 不在 taxonomy 中`);
      });
    }
  }
  if (review.tags !== undefined) {
    if (!Array.isArray(review.tags)) fail(`${label}：tags 必须是数组`);
    else {
      if (new Set(review.tags).size !== review.tags.length) fail(`${label}：tags 不能重复`);
      review.tags.forEach(tag => {
        if (!taxonomy.tags.has(tag)) fail(`${label}：标签 ${tag} 不在 taxonomy 中`);
      });
    }
  }
  if (!isDate(review.publishedAt)) fail(`${label}：publishedAt 不合法`);
  if (!isInteger(review.revision) || review.revision < 1) fail(`${label}：revision 必须是正整数`);
  checkSensitiveText([review.comment, review.title].filter(Boolean).join('\n'), label);
}

function main() {
  const taxonomy = validateTaxonomy();
  if (!taxonomy) {
    report();
    return;
  }

  const companyDir = join(dataDir, 'companies');
  const companyFiles = existsSync(companyDir)
    ? readdirSync(companyDir).filter(name => name.endsWith('.json'))
    : [];
  const companies = new Map();
  companyFiles.forEach(fileName => {
    const result = validateCompany(fileName);
    if (!result) return;
    if (companies.has(result.company.id)) fail(`data/companies：公司 id 重复 ${result.company.id}`);
    companies.set(result.company.id, result);
  });

  const seenReviewIds = new Set();
  let reviewCount = 0;
  if (existsSync(join(dataDir, 'reviews'))) {
    readdirSync(join(dataDir, 'reviews')).forEach(companyId => {
      const dir = join(dataDir, 'reviews', companyId);
      if (!statSync(dir).isDirectory()) return;
      const reviewFiles = readdirSync(dir).filter(name => name.endsWith('.json'));
      if (!reviewFiles.length) return;
      const company = companies.get(companyId);
      if (!company) return fail(`data/reviews/${companyId}：没有对应的公司文件`);
      reviewFiles.forEach(fileName => {
        validateReview(fileName, companyId, company, taxonomy, seenReviewIds);
        reviewCount++;
      });
    });
  }

  console.log(`已校验 ${companies.size} 家公司、${reviewCount} 条评价`);
  report();
}

function report() {
  if (!errors.length) {
    console.log('数据校验通过');
    return;
  }
  console.error(`数据校验失败，共 ${errors.length} 项：`);
  errors.forEach(message => console.error(`- ${message}`));
  process.exitCode = 1;
}

main();
