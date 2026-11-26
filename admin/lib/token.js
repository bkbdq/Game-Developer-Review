// 管理员 token 存储：cookie 保留 30 天，避免每次打开审核台都要重新粘贴 PAT
const COOKIE_NAME = 'gdr_admin_token';
const LEGACY_KEY = 'gdr.admin.token';
const MAX_AGE = 30 * 24 * 60 * 60; // 30 天（秒）

function readCookie() {
  const prefix = `${COOKIE_NAME}=`;
  const item = document.cookie
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith(prefix));
  if (!item) return '';
  try {
    return decodeURIComponent(item.slice(prefix.length));
  } catch {
    return '';
  }
}

export function getToken() {
  const fromCookie = readCookie();
  if (fromCookie) return fromCookie;
  // 兼容旧版 sessionStorage 登录：读到后迁移到 cookie
  const legacy = sessionStorage.getItem(LEGACY_KEY);
  if (legacy) {
    setToken(legacy);
    return legacy;
  }
  return '';
}

export function setToken(token) {
  if (!token) return;
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE_NAME}=${encodeURIComponent(token)}; Max-Age=${MAX_AGE}; Path=/; SameSite=Strict${secure}`;
  sessionStorage.removeItem(LEGACY_KEY);
}

export function clearToken() {
  const secure = location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Strict${secure}`;
  sessionStorage.removeItem(LEGACY_KEY);
}
