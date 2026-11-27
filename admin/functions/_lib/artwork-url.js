export function webUrl(value, base) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return null;
  try {
    const u = new URL(value, base);
    if (u.protocol !== 'https:' || u.port || u.username || u.password || !u.hostname.includes('.') ||
        (u.hostname.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) || u.hostname.endsWith('.localhost') || u.hostname.endsWith('.local')) return null;
    u.hash = '';
    return u.href;
  } catch { return null; }
}
