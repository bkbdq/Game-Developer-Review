import assert from 'node:assert/strict';
import { onRequestPost, onRequestGet } from '../site/functions/api/requests.js';
import { onRequestPost as contactPost } from '../site/functions/api/contact.js';
import { processRequest, handleContact } from '../admin/functions/_lib/store.js';
import { runCleanup } from '../worker/cleanup.mjs';

const receipt = '4d0f3f0e-8a3d-4b2f-9c1e-7f6a5b4c3d2e';

function publicDb() {
  const requests = [];
  const contacts = [];
  return {
    requests,
    contacts,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('COUNT(*)')) return { count: 0 };
              if (sql.includes('FROM submissions WHERE id')) {
                return {
                  id: receipt,
                  status: 'approved',
                  review_id: 'rv_TEST1',
                  payload: JSON.stringify({ payload: { companyId: 'c_test' } }),
                };
              }
              return null;
            },
            async all() {
              if (sql.includes('FROM requests WHERE receipt')) return { results: requests };
              return { results: [] };
            },
            async run() {
              if (sql.startsWith('INSERT INTO requests')) {
                requests.push({
                  id: args[0], receipt: args[1], type: args[2], message: args[3],
                  reviewId: args[4], companyId: args[5], status: 'received', createdAt: args[6],
                });
              }
              if (sql.startsWith('INSERT INTO contact_messages')) {
                contacts.push({ id: args[0], message: args[1], contact: args[2], createdAt: args[3] });
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

const env = { DB: publicDb(), IP_SALT: 'salt' };
const headers = {
  'Content-Type': 'application/json',
  Origin: 'https://goodcorp.games',
  'CF-Connecting-IP': '1.2.3.4',
};

const create = await onRequestPost({
  request: new Request('https://goodcorp.games/api/requests', {
    method: 'POST', headers, body: JSON.stringify({ receipt, type: 'deletion', message: '请删除我的评价' }),
  }),
  env,
});
assert.equal(create.status, 202);
assert.equal(env.DB.requests.length, 1);
assert.equal(env.DB.requests[0].reviewId, 'rv_TEST1');
assert.equal(env.DB.requests[0].companyId, 'c_test');

const list = await onRequestGet({
  request: new Request(`https://goodcorp.games/api/requests?receipt=${receipt}`, { headers }),
  env,
});
const listed = await list.json();
assert.equal(list.status, 200);
assert.equal(listed.requests.length, 1);
assert.equal(listed.requests[0].type, 'deletion');

const unknown = await onRequestPost({
  request: new Request('https://goodcorp.games/api/requests', {
    method: 'POST', headers, body: JSON.stringify({ receipt: 'bad', type: 'deletion', message: 'x' }),
  }),
  env,
});
assert.equal(unknown.status, 400);

const contact = await contactPost({
  request: new Request('https://goodcorp.games/api/contact', {
    method: 'POST', headers, body: JSON.stringify({ message: '页面有问题', contact: 'me@example.com' }),
  }),
  env,
});
assert.equal(contact.status, 202);
assert.equal(env.DB.contacts.length, 1);

function adminDb() {
  let request = {
    id: 'req_1', receipt, type: 'deletion', status: 'received',
    review_id: 'rv_TEST1', company_id: 'c_test',
  };
  let contactRow = { status: 'received' };
  const audits = [];
  return {
    audits,
    get request() { return request; },
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.includes('FROM requests WHERE id')) return request;
              if (sql.includes('FROM contact_messages WHERE id')) return contactRow;
              return null;
            },
            async run() {
              if (sql.startsWith('UPDATE requests')) request = { ...request, status: args[0] };
              if (sql.startsWith('UPDATE contact_messages')) contactRow = { status: 'handled' };
              if (sql.startsWith('INSERT INTO audit_log')) audits.push(args);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

const admin = adminDb();
const processed = await processRequest(admin, {
  id: 'req_1', action: 'process', note: '已删除公开评价',
  reviewer: 'devA', reviewId: 'rv_TEST1', companyId: 'c_test',
});
assert.equal(processed.ok, true);
assert.equal(admin.request.status, 'processed');
assert.equal(admin.audits[0][1], 'delete');
assert.equal(admin.audits[0][3], receipt);

const contacted = await handleContact(admin, { id: 'c1', reviewer: 'devA', note: '已回复' });
assert.equal(contacted.ok, true);
assert.equal(admin.audits[1].length, 4);
assert.equal(admin.audits[1][1], 'devA');

const steps = [];
const cleanupDb = {
  prepare(sql) {
    return {
      bind(...args) {
        return {
          async run() {
            steps.push({ sql, args });
            return { meta: { changes: 1 } };
          },
        };
      },
    };
  },
};
await runCleanup(cleanupDb, Date.UTC(2026, 11, 1));
assert.equal(steps.length, 9);
assert.ok(steps[0].sql.includes("status = 'approved'"));
assert.ok(steps[1].sql.includes("status = 'rejected'"));
assert.ok(steps[2].sql.includes("status = 'pending'"));
assert.ok(steps[3].sql.includes('json_remove'));
assert.ok(steps[4].sql.includes('UPDATE requests SET ip_hash'));
assert.ok(steps[5].sql.includes('UPDATE contact_messages SET ip_hash'));
assert.ok(steps[6].sql.includes('FROM requests'));
assert.ok(steps[7].sql.includes('FROM contact_messages'));
assert.ok(steps[8].sql.includes('contact = NULL'));

console.log('M6 申请 / 联系 / 清理测试通过');
