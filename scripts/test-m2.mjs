import assert from 'node:assert/strict';
import {
  parseSubmissionBody,
  normalize,
  validate,
  verifyPow,
  hashIp,
  dedupeHash,
  sha256Hex,
} from '../functions/_lib/core.js';
import { issueChallenge, verifyChallenge } from '../functions/_lib/pow.js';

const submissionId = '4d0f3f0e-8a3d-4b2f-9c1e-7f6a5b4c3d2e';
const base = {
  submissionId,
  company: '  云岬互动 ',
  project: '星港',
  score: '4',
  comment: '项目节奏清楚，评审也及时。',
  wish: '',
  role: 'program',
  tenure: '1-3y',
  employment: 'former',
  city: 'shanghai',
  consent: 'on',
  challenge: 'challenge',
  nonce: '1',
  elapsed: '8000',
  js: '1',
  website: '',
};

const input = normalize(base);
assert.equal(input.company, '云岬互动');
assert.equal(input.score, 4);
assert.equal(input.consent, true);
assert.deepEqual(input.profile, { role: 'program', tenure: '1-3y', employment: 'former', city: 'shanghai' });
assert.equal(normalize({ ...base, companyId: 'c_mihoyo' }).companyId, 'c_mihoyo');
assert.equal(normalize({ ...base, companyId: 'bad id' }).companyId, '');

const ok = validate(input);
assert.equal(ok.ok, true);
assert.deepEqual(ok.errors, []);
assert.deepEqual(ok.flags, []);

const missingConsent = validate(normalize({ ...base, consent: '' }));
assert.equal(missingConsent.ok, false);
assert.ok(missingConsent.errors.includes('consent'));

const badScore = validate(normalize({ ...base, score: '6' }));
assert.equal(badScore.ok, false);
assert.ok(badScore.errors.includes('score'));

const longComment = validate(normalize({ ...base, comment: '字'.repeat(2001) }));
assert.equal(longComment.ok, false);
assert.ok(longComment.errors.includes('comment'));

const tooManyUrls = validate(normalize({ ...base, comment: 'https://a.test https://b.test https://c.test' }));
assert.equal(tooManyUrls.ok, false);
assert.ok(tooManyUrls.errors.includes('urls'));

const honeypot = validate(normalize({ ...base, website: 'spam' }));
assert.ok(honeypot.flags.includes('suspected'));

const native = validate(normalize({ ...base, js: '' }));
assert.ok(native.flags.includes('no_js'));

const hiddenProject = normalize({ ...base, project: '星港', anonymousProject: 'on' });
assert.equal(hiddenProject.projectHidden, true);
assert.equal(hiddenProject.project, '');
assert.equal(validate(hiddenProject).ok, true);

const json = parseSubmissionBody(JSON.stringify({ company: 'A' }), 'application/json');
assert.equal(json.data.company, 'A');
const form = parseSubmissionBody('company=B&score=3', 'application/x-www-form-urlencoded');
assert.equal(form.data.company, 'B');
assert.equal(parseSubmissionBody('{bad', 'application/json').error, 'INVALID_INPUT');

assert.equal(await verifyPow('challenge', '0', 1), false);
let nonce = 0;
while (!(await verifyPow('challenge', String(nonce), 2))) nonce += 1;
assert.equal(await verifyPow('challenge', String(nonce), 2), true);

assert.equal((await hashIp('1.2.3.4', 'salt')).length, 16);
assert.equal((await dedupeHash(input)).length, 32);
assert.equal(await sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

const issued = await issueChallenge({ secret: 'test-secret', difficulty: 2 });
assert.match(issued.challenge, /^v1\./);
assert.equal(issued.difficulty, 2);
const verified = await verifyChallenge(issued.challenge, 'test-secret');
assert.equal(verified.ok, true);
assert.equal(verified.payload.d, 2);
assert.equal((await verifyChallenge(issued.challenge, 'wrong-secret')).ok, false);
const expired = await issueChallenge({ secret: 'test-secret', ttlMs: -1000 });
assert.equal((await verifyChallenge(expired.challenge, 'test-secret')).ok, false);

console.log('M2 校验与 PoW 测试通过');
