import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sizes } from '../admin/lib/artwork-sizes.js';
import { downloadImage, limitedBytes, onlineProviders, searchArtwork } from './artwork-sources.mjs';
import { deepSeekArtwork } from './artwork-deepseek.mjs';

const companyId = /^c_[a-z0-9_-]+$/;
const projectId = /^p_[a-z0-9_-]+$/;
const versionId = /^[a-f0-9]{16}$/;
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const reply = (res, value, status = 200) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
};

async function metadata(dir) {
  try { return JSON.parse(await readFile(join(dir, 'current.json'), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export function createArtworkLibrary(root, { deepSeekKey = process.env.DEEPSEEK_API_KEY?.trim() } = {}) {
  const companies = join(root, 'data', 'companies');
  const images = join(root, 'site', 'public', 'images', 'catalog');
  function directory(company, target) {
    if (!companyId.test(company) || !(target === 'studio' || projectId.test(target))) throw error('无效的素材对象');
    return join(images, company, target);
  }

  async function catalog() {
    const files = (await readdir(companies)).filter(f => f.endsWith('.json'));
    const groups = await Promise.all(files.map(async file => {
      const text = await readFile(join(companies, file), 'utf8');
      const bytes = Buffer.from(text.replace(/\r\n/g, '\n'));
      const companySha = createHash('sha1').update('blob ' + bytes.length + '\0').update(bytes).digest('hex');
      const c = JSON.parse(text);
      return Promise.all([{ id: 'studio', name: c.name }, ...c.projects].map(async p => ({
        company: c.id, companySha, studio: c.name, target: p.id, name: p.name,
        kind: p.id === 'studio' ? 'company' : 'project',
        draft: await metadata(directory(c.id, p.id)),
      })));
    }));
    return groups.flat().sort((a,b) => a.name.localeCompare(b.name, 'zh-CN'));
  }

  async function prepare(options, bytes) {
    const { company, target, mode, title, page, provider } = options;
    const x = Number(options.x), y = Number(options.y);
    directory(company, target);
    if (!['contain', 'cover'].includes(mode) || ![x,y].every(n => Number.isFinite(n) && n >= 0 && n <= 100)) throw error('裁切参数无效');
    if (!title || title.length > 180 || ![...onlineProviders, '维基百科', '本机图片', '剪贴板图片'].includes(provider) ||
        (page && (!/^https:\/\//.test(page) || page.length > 2048))) throw error('图片来源无效');
    const { default: sharp } = await import('sharp');
    const input = sharp(bytes, { limitInputPixels: 40000000, failOn: 'error' });
    const { format } = await input.metadata();
    if (!['jpeg','png','webp'].includes(format)) throw error('请选择 JPEG、PNG 或 WebP');
    const { data, info } = await input.autoOrient().resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 92 }).toBuffer({ resolveWithObject: true });
    const image = options.image || '';
    if (image && (!image.startsWith('https://') || image.length > 2048)) throw error('图片地址无效');
    const settings = { mode, x, y, title, page, provider, image };
    const version = createHash('sha256').update(data).update(JSON.stringify(settings)).digest('hex').slice(0,16);
    const saved = { version, ...settings };
    const formats = sizes[target === 'studio' ? 'company' : 'project'];
    const files = {};
    for (const { key, width, height } of formats) {
      let pipeline = sharp(data);
      if (mode === 'contain') {
        pipeline = pipeline.resize(width, height, { fit: 'contain', background: '#e9eff1' });
      } else {
        const scale = Math.min(info.width / width, info.height / height);
        const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
        pipeline = pipeline.extract({ left: Math.round((info.width - w) * x / 100),
          top: Math.round((info.height - h) * y / 100), width: w, height: h }).resize(width, height, { fit: 'fill' });
      }
      const output = await pipeline.flatten({background: '#e9eff1'}).webp({quality: 86}).toBuffer();
      files[key] = output.toString('base64');
    }
    // 归一化原图只回传给浏览器做本地预览与版本哈希，不进上传表单，也不入 R2。
    return { saved, source:data.toString('base64'), files };
  }

  async function handle(req, res, url) {
    const p = Object.fromEntries(url.searchParams);
    const action = url.pathname.slice('/api/local/artwork/'.length);
    try {
      const host = req.headers.host;
      if (!/^127\.0\.0\.1:\d+$/.test(host) && !/^localhost:\d+$/.test(host)) throw error('仅支持本机审核台', 403);
      if (req.method === 'POST') {
        if (req.headers.origin !== 'http://' + host || req.headers['x-artwork-save'] !== '1') throw error('请求来源无效', 403);
        if (action === 'deepseek') {
          if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) !== 0 ||
              [...url.searchParams.keys()].some(k => !['q','kind','studio','work'].includes(k))) throw error('找图参数无效');
          const q = p.q?.trim(), studio = (p.studio || '').trim();
          if (!q || q.length > 100 || studio.length > 180 || !['project','company'].includes(p.kind)) throw error('请输入有效名称');
          const works = url.searchParams.getAll('work').map(s => s.trim());
          if (works.length > 5 || works.some(s => !s || s.length > 160)) throw error('关联作品名称无效');
          const authorization = req.headers.authorization || '';
          const reviewerToken = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
          return reply(res, await deepSeekArtwork(q, p.kind, studio, deepSeekKey, works, reviewerToken));
        }
        if (action !== 'prepare') throw error('路径无效', 404);
        return reply(res, await prepare(p, await limitedBytes(req)));
      }
      if (req.method !== 'GET') throw error('请求方式无效', 405);
      if (action === 'catalog') return reply(res, await catalog());
      if (action === 'search') {
        const term = p.q?.trim();
        if (!term || term.length > 100 || !['project','company'].includes(p.kind)) throw error('请输入有效名称');
        return reply(res, await searchArtwork(term, p.kind));
      }
      let image;
      if (action === 'image') image = await downloadImage(p.url);
      else if (action === 'original') {
        const dir = directory(p.company, p.target);
        const entry = await metadata(dir);
        if (!entry || !versionId.test(entry.version)) throw error('还没有已保存的原图', 404);
        if (p.v !== entry.version) throw error('本机配图已更新，请刷新后重试', 409);
        image = { mime: 'image/webp', bytes: await readFile(join(dir, entry.version + '-source.webp')) };
      } else throw error('路径无效', 404);
      res.writeHead(200, { 'Content-Type': image.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=600' });
      res.end(image.bytes);
    } catch (e) {
      reply(res, { message: e.message || '素材处理失败' }, e.status || 400);
    }
  }
  return { handle, catalog, prepare };
}
