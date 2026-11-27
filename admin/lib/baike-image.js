export function isBaikeImage(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      ['bkimg.cdn.bcebos.com', 'bkimg.cdn.baidu.com'].includes(url.hostname) &&
      url.pathname.startsWith('/pic/');
  } catch {
    return false;
  }
}
