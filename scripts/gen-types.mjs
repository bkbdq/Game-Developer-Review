import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaDir = join(root, 'schema');
const outFile = join(root, 'site', 'src', 'lib', 'schema-types.ts');

const targets = [
  ['review', 'ReviewFile'],
  ['company', 'CompanyFile'],
  ['taxonomy', 'TaxonomyFile'],
];

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const indent = level => '  '.repeat(level);
const isValidIdentifier = key => /^[A-Za-z_$][\w$]*$/.test(key);

function literal(value) {
  return typeof value === 'string' ? JSON.stringify(value) : String(value);
}

function resolveRef(ref, root) {
  if (!ref.startsWith('#/')) throw new Error(`不支持的 $ref：${ref}`);
  return ref.slice(2).split('/').reduce((node, key) => node?.[key], root);
}

function typeOf(schema, root, level) {
  if (!schema || typeof schema !== 'object') return 'unknown';
  if (schema.$ref) return typeOf(resolveRef(schema.$ref, root), root, level);
  if ('const' in schema) return literal(schema.const);
  if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(' | ');

  const type = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (type.includes('object') || schema.properties) {
    const properties = schema.properties || {};
    const required = new Set(schema.required || []);
    const keys = Object.keys(properties);
    if (!keys.length) return 'Record<string, unknown>';
    const lines = keys.map(key => {
      const optional = required.has(key) ? '' : '?';
      const name = isValidIdentifier(key) ? key : JSON.stringify(key);
      const property = typeOf(properties[key], root, level + 1);
      return `${indent(level + 1)}${name}${optional}: ${property};`;
    });
    return `{\n${lines.join('\n')}\n${indent(level)}}`;
  }
  if (type.includes('array')) {
    const item = typeOf(schema.items || {}, root, level);
    return /[|&]/.test(item) ? `(${item})[]` : `${item}[]`;
  }
  if (type.includes('integer') || type.includes('number')) return 'number';
  if (type.includes('boolean')) return 'boolean';
  if (type.includes('null')) return 'null';
  return 'string';
}

const outputs = [];
targets.forEach(([file, name]) => {
  const schema = readJson(join(schemaDir, `${file}.schema.json`));
  const body = typeOf(schema, schema, 0);
  outputs.push(`export type ${name} = ${body};`);
});

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  `// 由 scripts/gen-types.mjs 根据 schema/*.schema.json 自动生成，请勿手改。\n\n${outputs.join('\n\n')}\n`,
  'utf8',
);
console.log(`已生成 ${outFile}`);
