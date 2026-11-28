import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DomUtils, parseDocument } from 'htmlparser2';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const labels = /^(?:[●•✓✔]\s*)?(?:已上线|在研|已取消|状态未知)$/;
const badgeClasses = new Set(['project-status', 'status-mark', 'board-status']);

test('访客页面不展示项目研发状态', async () => {
  const paths = (await readdir(dist, { recursive: true })).filter(file => file.endsWith('.html'));
  assert.ok(paths.includes('index.html'), '缺少展示站首页');
  const violations = [];
  for (const file of paths) {
    const doc = parseDocument(await readFile(path.join(dist, file), 'utf8'));
    const badge = DomUtils.findOne(el => {
      const classes = (el.attribs.class || '').split(/\s+/);
      if (classes.some(name => badgeClasses.has(name))) return true;
      if (['live', 'dev', 'cancelled', 'unknown'].includes(el.attribs['data-status'])) return true;
      // Company cards previously rendered plain status text in their metadata row.
      return classes.includes('tile-context') && el.children.some(child =>
        labels.test(DomUtils.textContent(child).trim()));
    }, doc.children);
    if (badge) violations.push(file);
  }
  assert.deepEqual(violations, [], '以下页面仍显示项目研发状态');
});
