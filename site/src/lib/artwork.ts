import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { href } from './data';

export function catalogArtwork(company: string, target = 'studio') {
  if (!/^c_[a-z0-9_-]+$/.test(company) || !(target === 'studio' || /^p_[a-z0-9_-]+$/.test(target))) return;
  const dir = `images/catalog/${company}/${target}`;
  try {
    const { version, storage } = JSON.parse(readFileSync(resolve('public', dir, 'current.json'), 'utf8'));
    if (!/^[0-9a-f]{16}$/.test(version)) throw new Error('配图版本无效：' + dir);
    const origin = import.meta.env.PUBLIC_ARTWORK_ORIGIN || 'https://admin.goodcorp.games';
    const url = (key: string) => storage === 'r2'
      ? `${origin}/api/artwork/${company}/${target}/${version}/${key}.webp` : href(`${dir}/${version}-${key}.webp`);
    return { cover: url('cover'), card: url('card'), detail: url('detail'), banner: url('banner') };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}
