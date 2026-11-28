import { authenticate, json, fail } from './auth.js';
import { sizes } from '../../lib/artwork-sizes.js';

const limit = 24 * 1024 * 1024;
function location(parts) {
  if (!Array.isArray(parts)) return null;
  const [company, target, version] = parts;
  if (!/^c_[a-z0-9_-]+$/.test(company) || !/^(studio|p_[a-z0-9_-]+)$/.test(target) || !/^[a-f0-9]{16}$/.test(version)) return null;
  return {prefix:`catalog/${company}/${target}/${version}/`, names:sizes[target === 'studio' ? 'company' : 'project'].map(s => s.key)};
}

export async function uploadArtwork({request, env, params}) {
  const session = await authenticate(request,env);
  if (session.error) return session.error;
  if (!env.ARTWORK) return fail(503,'审核后台尚未绑定配图 R2 存储桶');
  const dir = location(params.path);
  if (!dir || params.path.length !== 3) return fail(400,'配图路径无效');
  const length = Number(request.headers.get('content-length'));
  if (length > limit) return fail(413,'配图超过 24 MB');
  let form, received = 0;
  try {
    const bounded = request.body.pipeThrough(new TransformStream({transform(chunk,controller) {
      received += chunk.byteLength;
      if (received > limit) throw new Error('too large');
      controller.enqueue(chunk);
    }}));
    form = await new Response(bounded,{headers:request.headers}).formData();
  } catch { return received > limit ? fail(413,'配图超过 24 MB') : fail(400,'无法读取配图文件'); }
  if ([...form.keys()].length !== dir.names.length) return fail(400,'配图文件不完整');
  const files = [];
  for (const name of dir.names) {
    const file = form.get(name);
    if (!file || typeof file === 'string' || file.type !== 'image/webp' || file.size < 16 || file.size > 12 * 1024 * 1024) return fail(400,'需要有效的 WebP 图片');
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (String.fromCharCode(...bytes.slice(0,4)) !== 'RIFF' || String.fromCharCode(...bytes.slice(8,12)) !== 'WEBP' ||
        new DataView(bytes.buffer).getUint32(4,true) !== bytes.length - 8) return fail(400,'WebP 文件无效');
    files.push({key:dir.prefix + name + '.webp',bytes});
  }
  for (const {key,bytes} of files) {
    const hash = await crypto.subtle.digest('SHA-256',bytes);
    const digest = Array.from(new Uint8Array(hash),b => b.toString(16).padStart(2,'0')).join('');
    const stored = await env.ARTWORK.put(key,bytes,{onlyIf:{etagDoesNotMatch:'*'}, sha256:hash,
      httpMetadata:{contentType:'image/webp'},customMetadata:{sha256:digest}});
    if (!stored && (await env.ARTWORK.head(key))?.customMetadata?.sha256 !== digest) return fail(409,'同一版本已有不同图片，请刷新后重试');
  }
  return json({ok:true,version:params.path[2]});
}

export async function readArtwork({env,params,request}) {
  const dir = location(params.path);
  const name = params.path?.[3];
  if (!dir || params.path.length !== 4 || !dir.names.some(k => name === k + '.webp')) return fail(404,'图片不存在');
  if (!env.ARTWORK) return fail(503,'审核后台尚未绑定配图 R2 存储桶');
  const key = dir.prefix + name;
  const head = request.method === 'HEAD';
  const object = head ? await env.ARTWORK.head(key) : await env.ARTWORK.get(key);
  if (!object) return fail(404,'图片不存在');
  return new Response(head ? null : object.body,{headers:{'Content-Type':'image/webp','Content-Length':String(object.size),
    'Cache-Control':'public, max-age=31536000, immutable','ETag':object.httpEtag,'X-Content-Type-Options':'nosniff'}});
}
