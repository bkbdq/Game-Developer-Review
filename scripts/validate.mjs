// 校验入口：npm run data:validate（CI 中先执行 npm ci 安装 ajv）
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(root, 'data');
const schemaDir = resolve(root, 'schema');
const errors = [];

const fail = message => errors.push(message);
const isString = value => typeof value === 'string';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isDate = value => isString(value) && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
const isInteger = value => Number.isInteger(value);

const SENSITIVE_PATTERNS = [
  { name: '邮箱', pattern: /[\w.+-]+@[\w-]+\.[\w.]+/ },
  { name: '手机号', pattern: /(?<!\d)1[3-9]\d{9}(?!\d)/ },
  { name: '身份证号', pattern: /(?<!\d)\d{17}[\dXx](?!\d)/ },
];

const ajv = new Ajv2020({ allErrors: true, strict: false });
ajv.addFormat('date', { type: 'string', validate: isDate });

const validators = {};

function compile(name) {
  const schema = readJson(join(schemaDir, `${name}.schema.json`), `schema/${name}.schema.json`);
  if (!schema) return null;
  try {
    return ajv.compile(schema);
  } catch (error) {
    fail(`schema/${name}.schema.json：无法编译（${error.message}）`);
    return null;
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label}：无法解析 JSON（${error.message}）`);
    return null;
  }
}

function formatPath(instancePath) {
  if (!instancePath) return '根对象';
  return instancePath
    .split('/')
    .filter(Boolean)
    .map(part => (/^\d+$/.test(part) ? `[${part}]` : `.${part}`))
    .join('')
    .replace(/^\./, '');
}

function checkSchema(validator, value, label) {
  if (validator(value)) return true;
  const details = (validator.errors || [])
    .map(error => `${formatPath(error.instancePath)} ${error.message}`)
    .join('；');
  fail(`${label}：不符合 schema（${details}）`);
  return false;
}

function checkSensitiveText(text, label) {
  SENSITIVE_PATTERNS.forEach(({ name, pattern }) => {
    if (pattern.test(text)) fail(`${label}：疑似包含${name}`);
  });
}

function checkEntries(entries, label) {
  if (!Array.isArray(entries)) return new Set();
  const keys = new Set();
  entries.forEach((entry, index) => {
    if (!isObject(entry)) return;
    if (keys.has(entry.key)) fail(`${label}[${index}]：key 重复 ${entry.key}`);
    keys.add(entry.key);
  });
  return keys;
}

function validateTaxonomy() {
  const taxonomy = readJson(join(dataDir, 'taxonomy.json'), 'taxonomy.json');
  if (!taxonomy) return null;
  if (validators.taxonomy && !checkSchema(validators.taxonomy, taxonomy, 'taxonomy.json')) return null;
  const result = {};
  ['roles', 'tenures', 'employments', 'cities', 'tags'].forEach(dim => {
    result[dim] = checkEntries(taxonomy[dim], `taxonomy.json.${dim}`);
  });
  return result;
}

function validateCompany(fileName) {
  const label = `data/companies/${fileName}`;
  const company = readJson(join(dataDir, 'companies', fileName), label);
  if (!company) return null;
  if (validators.company) checkSchema(validators.company, company, label);
  if (fileName !== `${company.id}.json`) fail(`${label}：文件名必须与 id 一致`);
  const projectIds = new Set();
  (Array.isArray(company.projects) ? company.projects : []).forEach((project, index) => {
    const projectLabel = `${label}.projects[${index}]`;
    if (!isObject(project)) return;
    if (projectIds.has(project.id)) fail(`${projectLabel}：id 重复 ${project.id}`);
    projectIds.add(project.id);
  });
  return { company, projectIds };
}

function validateReview(fileName, companyId, company, taxonomy, seenIds) {
  const label = `data/reviews/${companyId}/${fileName}`;
  const review = readJson(join(dataDir, 'reviews', companyId, fileName), label);
  if (!review) return;
  if (validators.review) checkSchema(validators.review, review, label);
  if (fileName !== `${review.id}.json`) fail(`${label}：文件名必须与 id 一致`);
  if (seenIds.has(review.id)) fail(`${label}：评价 id 重复 ${review.id}`);
  seenIds.add(review.id);
  if (review.companyId !== companyId) fail(`${label}：companyId 必须与目录一致`);
  if (review.projectAnonymous && review.projectId !== undefined) {
    fail(`${label}：匿名项目评价不能同时关联 projectId`);
  }
  if (review.projectId !== undefined && !company.projectIds.has(review.projectId)) {
    fail(`${label}：projectId ${review.projectId} 不存在于公司项目列表`);
  }
  if (isObject(review.profile)) {
    Object.entries(review.profile).forEach(([dim, key]) => {
      const dictionary = { role: 'roles', tenure: 'tenures', employment: 'employments', city: 'cities' }[dim];
      if (dictionary && !taxonomy[dictionary].has(key)) fail(`${label}：profile.${dim} 的值 ${key} 不在 taxonomy 中`);
    });
  }
  if (Array.isArray(review.tags)) {
    if (new Set(review.tags).size !== review.tags.length) fail(`${label}：tags 不能重复`);
    review.tags.forEach(tag => {
      if (!taxonomy.tags.has(tag)) fail(`${label}：标签 ${tag} 不在 taxonomy 中`);
    });
  }
  checkSensitiveText([review.comment, review.title].filter(Boolean).join('\n'), label);
}

function main() {
  validators.taxonomy = compile('taxonomy');
  validators.company = compile('company');
  validators.review = compile('review');

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
