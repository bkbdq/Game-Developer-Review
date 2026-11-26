import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import {
  newReviewId,
  parseSubmission,
  validateDraft,
  validateCompany,
  buildReview,
  buildCompany,
  mergeCompany,
  today,
} from '../admin/lib/review.js';
import { publishReview } from '../admin/lib/publish.js';
import {
  listSubmissions,
  approveSubmission,
  rejectSubmission,
  listAuditLog,
} from '../admin/functions/_lib/store.js';

const taxonomy = {
  roles: [{ key: 'program', label: '程序' }],
  tenures: [{ key: '1-3y', label: '1–3 年' }],
  employments: [{ key: 'former', label: '已离职' }],
  cities: [{ key: 'shanghai', label: '上海' }],
  tags: [{ key: 'overtime', label: '加班' }],
};

const company = {
  schemaVersion: 1,
  id: 'c_cloudcape',
  slug: 'cloudcape',
  name: '云岬互动',
  aliases: [],
  projects: [{ id: 'p_starport', name: '星港', status: 'live' }],
  createdAt: '2026-11-01',
  updatedAt: '2026-11-01',
};

const draft = {
  id: newReviewId(),
  companyId: 'c_cloudcape',
  projectId: 'p_starport',
  score: 4,
  title: '节奏清楚',
  comment: '项目节奏清楚，评审也及时。',
  profile: { role: 'program', tenure: '1-3y', employment: 'former', city: 'shanghai' },
  tags: ['overtime'],
  publishedAt: today(),
};

assert.match(draft.id, /^rv_[0-9A-Z]+$/);
assert.notEqual(newReviewId(), newReviewId());

assert.deepEqual(validateDraft(draft, { taxonomy, company }), []);
assert.deepEqual(validateCompany(company), []);

assert.ok(validateDraft({ ...draft, score: 6 }, { taxonomy, company }).some(message => message.includes('评分')));
assert.ok(validateDraft({ ...draft, projectId: 'p_missing' }, { taxonomy, company }).some(message => message.includes('项目')));
assert.ok(validateDraft({ ...draft, tags: ['unknown'] }, { taxonomy, company }).some(message => message.includes('标签')));
assert.ok(validateCompany({ ...company, slug: '大写 Slug' }).length > 0);

const review = buildReview(draft);
assert.equal(review.schemaVersion, 1);
assert.equal(review.projectId, 'p_starport');
assert.equal(review.revision, 1);

const fresh = buildCompany({ id: 'c_new', slug: 'new', name: '新公司', project: { id: 'p_new', name: '新项目', status: 'dev' }, date: '2026-11-20' });
assert.equal(fresh.projects.length, 1);
const merged = mergeCompany(company, { project: { id: 'p_new', name: '新项目', status: 'dev' }, date: '2026-11-20' });
assert.equal(merged.projects.length, 2);
assert.equal(merged.updatedAt, '2026-11-20');
assert.equal(company.projects.length, 1);

const raw = {
  submissionId: '4d0f3f0e-8a3d-4b2f-9c1e-7f6a5b4c3d2e',
  submittedAt: '2026-11-20T10:00:00.000Z',
  payload: { company: '云岬互动', companyId: 'c_cloudcape', project: '星港', score: 4, comment: '正文', profile: { role: 'program' } },
  meta: { flags: ['fast_submit'], ipHash: 'abc' },
};
const view = parseSubmission(raw);
assert.equal(view.company, '云岬互动');
assert.equal(view.companyId, 'c_cloudcape');
assert.deepEqual(view.flags, ['fast_submit']);

// 发布：单次原子提交，且重复调用不再写公开仓
function mockClient({ reviewExists = false } = {}) {
  const calls = [];
  return {
    calls,
    async getTree() {
      calls.push(['getTree']);
      return { tree: reviewExists ? [{ type: 'blob', path: `data/reviews/c_cloudcape/${review.id}.json` }] : [] };
    },
    async getFile(owner, repo, path) {
      calls.push(['getFile', repo, path]);
      return reviewExists ? { path, sha: 'sha', content: '{}' } : null;
    },
    async getRef() { calls.push(['getRef']); return { object: { sha: 'base-sha' } }; },
    async getCommit() { calls.push(['getCommit']); return { tree: { sha: 'base-tree' } }; },
    async createBlob(owner, repo, content) { calls.push(['createBlob', content]); return { sha: `blob-${calls.length}` }; },
    async createTree(owner, repo, body) { calls.push(['createTree', body]); return { sha: 'new-tree' }; },
    async createCommit(owner, repo, body) { calls.push(['createCommit', body]); return { sha: 'new-commit' }; },
    async patchRef(owner, repo, branch, sha) { calls.push(['patchRef', branch, sha]); },
    async putFile() { calls.push(['putFile']); },
    async deleteFile() { calls.push(['deleteFile']); },
  };
}

const config = {
  owner: 'owner',
  publicRepo: 'public',
  publicBranch: 'main',
  companiesDir: 'data/companies',
  reviewsDir: 'data/reviews',
};

const client = mockClient();
const result = await publishReview({ client, config, review, company });
assert.equal(result.published, true);
const treeCall = client.calls.find(call => call[0] === 'createTree');
assert.deepEqual(treeCall[1].tree.map(item => item.path).sort(), [
  'data/companies/c_cloudcape.json',
  'data/reviews/c_cloudcape/' + review.id + '.json',
]);
const commitCall = client.calls.find(call => call[0] === 'createCommit');
assert.ok(commitCall[1].message.includes('data: publish'));
assert.ok(client.calls.some(call => call[0] === 'patchRef' && call[2] === 'new-commit'));
assert.ok(!client.calls.some(call => call[0] === 'deleteFile'));

const replay = await publishReview({ client: mockClient({ reviewExists: true }), config, review, company });
assert.equal(replay.published, false);

// D1 审核状态：用内存 SQLite 跑真实迁移
class TestDb {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(new URL('../survey/migrations/0001_submissions.sql', import.meta.url), 'utf8'));
    this.db.exec(readFileSync(new URL('../survey/migrations/0003_audit_log_enhance.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const statement = this.db.prepare(sql);
    return {
      params: [],
      bind(...params) { this.params = params; return this; },
      all() { return { results: statement.all(...this.params) }; },
      first() { return statement.get(...this.params) ?? null; },
      run() { return { meta: { changes: Number(statement.run(...this.params).changes) } }; },
    };
  }
}

const db = new TestDb();
const insert = (id, submittedAt, flags = '') => db.prepare(
  'INSERT INTO submissions (id, payload, status, flags, ip_hash, dedupe_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
).bind(
  id,
  JSON.stringify({ ...raw, submissionId: id, submittedAt }),
  'pending',
  flags,
  'iphash',
  'dedupe',
  submittedAt,
).run();

insert('11111111-1111-4111-8111-111111111111', '2026-11-20T09:00:00.000Z', 'fast_submit');
insert('22222222-2222-4222-8222-222222222222', '2026-11-20T10:00:00.000Z');

const pending = await listSubmissions(db, { status: 'pending' });
assert.equal(pending.total, 2);
assert.equal(pending.items.length, 2);
assert.equal(pending.items[0].id, '22222222-2222-4222-8222-222222222222');
assert.deepEqual(pending.items[1].flags, ['fast_submit']);

assert.equal((await approveSubmission(db, { id: pending.items[0].id, reviewId: 'bad', companyId: 'c_x', reviewer: 'devA' })).code, 'invalid');
assert.equal((await approveSubmission(db, { id: '33333333-3333-4333-8333-333333333333', reviewId: 'rv_1', companyId: 'c_x', reviewer: 'devA' })).code, 'not_found');

const approved = await approveSubmission(db, {
  id: pending.items[0].id,
  reviewId: 'rv_1',
  companyId: 'c_cloudcape',
  reviewer: 'devA',
  commitSha: 'abc1234',
});
assert.equal(approved.ok, true);
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'approve'").first().count, 1);
const audit = await listAuditLog(db, { action: 'approve' });
assert.equal(audit.total, 1);
assert.equal(audit.items[0].targetType, 'review');
assert.equal(audit.items[0].targetId, 'rv_1');
assert.deepEqual(audit.items[0].details, { commitSha: 'abc1234' });
assert.deepEqual(await approveSubmission(db, { id: pending.items[0].id, reviewId: 'rv_1', companyId: 'c_cloudcape', reviewer: 'devA' }), { ok: true, status: 'approved' });
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'approve'").first().count, 1);
assert.equal((await approveSubmission(db, { id: pending.items[0].id, reviewId: 'rv_2', companyId: 'c_cloudcape', reviewer: 'devA' })).code, 'conflict');

const rejected = await rejectSubmission(db, { id: pending.items[1].id, reason: '包含联系方式', reviewer: 'devA' });
assert.equal(rejected.ok, true);
assert.equal(db.prepare('SELECT reject_reason FROM submissions WHERE id = ?').bind(pending.items[1].id).first().reject_reason, '包含联系方式');
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'reject'").first().count, 1);
assert.deepEqual(await rejectSubmission(db, { id: pending.items[1].id, reason: '再拒绝一次', reviewer: 'devA' }), { ok: true, status: 'rejected' });
assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'reject'").first().count, 1);
assert.equal((await rejectSubmission(db, { id: pending.items[0].id, reason: '已发布', reviewer: 'devA' })).code, 'conflict');
assert.equal((await rejectSubmission(db, { id: pending.items[1].id, reason: '  ', reviewer: 'devA' })).code, 'invalid');

assert.equal((await listSubmissions(db, { status: 'pending' })).total, 0);
assert.equal((await listSubmissions(db, { status: 'approved' })).total, 1);
assert.equal((await listSubmissions(db, { status: 'rejected' })).total, 1);

console.log('M3 审核与发布流程测试通过');
