const ROLES = ['design', 'program', 'art', 'audio', 'ops', 'qa', 'pm', 'other'];
const TENURES = ['lt1y', '1-3y', '3-5y', 'gt5y'];
const EMPLOYMENTS = ['current', 'former', 'intern'];
const CITIES = ['beijing', 'shanghai', 'guangzhou', 'shenzhen', 'chengdu', 'hangzhou', 'other'];

export const LIMITS = {
  bodyBytes: 16 * 1024,
  company: 50,
  project: 50,
  comment: 2000,
  wish: 500,
};

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMPANY_ID = /^c_[a-z0-9_-]+$/;

export const isUuid = value => UUID_V4.test(value);

export function parseSubmissionBody(text, contentType = '') {
  if (contentType.includes('application/json')) {
    try {
      const data = JSON.parse(text);
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { error: 'INVALID_INPUT' };
      return { data };
    } catch {
      return { error: 'INVALID_INPUT' };
    }
  }
  return { data: Object.fromEntries(new URLSearchParams(text)) };
}

export function cleanText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const cleanLine = value => cleanText(value).replace(/\s+/g, ' ');

const toBool = value => value === true || value === 'true' || value === 'on' || value === '1';

export function normalize(raw = {}) {
  const profile = {};
  if (ROLES.includes(raw.role)) profile.role = raw.role;
  if (TENURES.includes(raw.tenure)) profile.tenure = raw.tenure;
  if (EMPLOYMENTS.includes(raw.employment)) profile.employment = raw.employment;
  if (CITIES.includes(raw.city)) profile.city = raw.city;
  const project = cleanLine(raw.project);
  // 问卷勾选「不公开项目名」时不再保存项目原文，只保留标记
  const projectHidden = toBool(raw.anonymousProject ?? raw.projectHidden);
  return {
    submissionId: cleanLine(raw.submissionId),
    companyId: COMPANY_ID.test(cleanLine(raw.companyId)) ? cleanLine(raw.companyId) : '',
    company: cleanLine(raw.company),
    project: projectHidden ? '' : project,
    projectHidden,
    score: Number(raw.score),
    comment: cleanText(raw.comment),
    wish: cleanText(raw.wish),
    profile,
    consent: toBool(raw.consent),
    challenge: cleanLine(raw.challenge),
    nonce: cleanLine(raw.nonce),
    honeypot: cleanLine(raw.website),
    elapsed: Number(raw.elapsed) || 0,
    js: toBool(raw.js),
  };
}

export function validate(input) {
  const errors = [];
  if (!UUID_V4.test(input.submissionId)) errors.push('submissionId');
  if (!input.company || input.company.length > LIMITS.company) errors.push('company');
  if (input.project.length > LIMITS.project) errors.push('project');
  if (!Number.isInteger(input.score) || input.score < 1 || input.score > 5) errors.push('score');
  if (!input.comment || input.comment.length > LIMITS.comment) errors.push('comment');
  if (input.wish.length > LIMITS.wish) errors.push('wish');
  if (!input.consent) errors.push('consent');
  const urls = (input.comment.match(/https?:\/\//gi) || []).length + (input.wish.match(/https?:\/\//gi) || []).length;
  if (urls > 2) errors.push('urls');

  const flags = [];
  if (input.honeypot) flags.push('suspected');
  if (input.elapsed > 0 && input.elapsed < 3000) flags.push('fast_submit');
  if (!input.js) flags.push('no_js');
  if (input.js && (!input.challenge || !input.nonce)) flags.push('no_pow');

  return { ok: errors.length === 0, errors, flags };
}

export function uaFamily(userAgent = '') {
  let browser = 'Other';
  if (/Edg\//.test(userAgent)) browser = 'Edge';
  else if (/Chrome\//.test(userAgent)) browser = 'Chrome';
  else if (/Firefox\//.test(userAgent)) browser = 'Firefox';
  else if (/Safari\//.test(userAgent)) browser = 'Safari';
  let os = 'Other';
  if (/Windows/.test(userAgent)) os = 'Windows';
  else if (/Android/.test(userAgent)) os = 'Android';
  else if (/iPhone|iPad|iPod/.test(userAgent)) os = 'iOS';
  else if (/Mac OS X/.test(userAgent)) os = 'macOS';
  else if (/Linux/.test(userAgent)) os = 'Linux';
  return `${browser}/${os}`;
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function verifyPow(challenge, nonce, difficulty = 3) {
  if (!challenge || !nonce) return false;
  const prefix = '0'.repeat(Math.max(1, Math.min(5, Number(difficulty) || 3)));
  const hash = await sha256Hex(`${challenge}:${nonce}`);
  return hash.startsWith(prefix);
}

export async function hashIp(ip, salt) {
  return (await sha256Hex(`${salt}:${ip}`)).slice(0, 16);
}

export async function dedupeHash(input) {
  const text = [input.company, input.project, input.comment].join('|').toLowerCase();
  return (await sha256Hex(text)).slice(0, 32);
}
