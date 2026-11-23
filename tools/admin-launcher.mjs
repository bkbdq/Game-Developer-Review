import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN_DIR = join(ROOT, 'admin');
const DEPLOY_DIR = resolve(ROOT, '..', '.gdr-deploy');
const API_ORIGIN = (process.env.ADMIN_API_ORIGIN || 'https://admin.goodcorp.games').replace(/\/$/, '');
const HOST = '127.0.0.1';
const BASE_PORT = Number(process.env.ADMIN_PORT || 8787);
const WRANGLER = 'wrangler@4.165.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

const SECRET_CANDIDATES = [
  process.env.CLOUDFLARE_ENV_FILE,
  join(ROOT, '.secrets', 'cloudflare.env'),
  resolve(ROOT, '..', '.secrets', 'cloudflare.env'),
].filter(Boolean);

let deploying = false;

function readEnvFile(path) {
  const vars = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    vars[match[1]] = value;
  }
  return vars;
}

function findSecrets() {
  for (const path of SECRET_CANDIDATES) {
    if (path && existsSync(path)) return { path, vars: readEnvFile(path) };
  }
  return null;
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function proxy(req, res, url) {
  const target = `${API_ORIGIN}${url.pathname}${url.search}`;
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (key === 'host' || key === 'content-length' || key === 'connection') continue;
    headers[key] = value;
  }
  try {
    const body = await readBody(req);
    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body: body.length ? body : undefined,
    });
    const payload = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(payload);
  } catch (error) {
    const cause = error.cause?.message || error.cause?.code;
    json(res, 502, { ok: false, message: `无法连接审核 API：${error.message}${cause ? `（${cause}）` : ''}` });
  }
}

function run(command, args, { cwd = ROOT, env = process.env, shell = process.platform === 'win32' } = {}) {
  return new Promise(resolveRun => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      windowsHide: true,
    });
    let output = '';
    const append = chunk => {
      output += chunk.toString();
      if (output.length > 20000) output = output.slice(-20000);
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', error => resolveRun({ code: 1, output: `${output}\n${error.message}` }));
    child.on('close', code => resolveRun({ code: code ?? 1, output }));
  });
}

async function deploySite(req, res) {
  if (deploying) return json(res, 409, { ok: false, message: '已有部署正在进行' });

  const secrets = findSecrets();
  const vars = secrets?.vars || {};
  if (!vars.CLOUDFLARE_API_TOKEN) {
    return json(res, 409, {
      ok: false,
      message: '本机未配置 Cloudflare token，跳过展示站更新',
    });
  }

  deploying = true;
  try {
    const proxy = vars.GIT_PROXY
      ? { HTTPS_PROXY: vars.GIT_PROXY, HTTP_PROXY: vars.GIT_PROXY }
      : {};
    const env = {
      ...process.env,
      ...proxy,
      CLOUDFLARE_API_TOKEN: vars.CLOUDFLARE_API_TOKEN,
      ...(vars.CLOUDFLARE_ACCOUNT_ID ? { CLOUDFLARE_ACCOUNT_ID: vars.CLOUDFLARE_ACCOUNT_ID } : {}),
    };

    console.log('[deploy] git fetch origin main');
    const fetched = await run('git', ['fetch', 'origin', 'main'], { env, shell: false });
    if (fetched.code !== 0) {
      console.error(fetched.output);
      return json(res, 500, { ok: false, message: '拉取 GitHub main 失败', log: fetched.output.slice(-4000) });
    }

    if (existsSync(DEPLOY_DIR) && !existsSync(join(DEPLOY_DIR, '.git'))) {
      rmSync(DEPLOY_DIR, { recursive: true, force: true });
    }

    console.log('[deploy] prepare clean worktree');
    const worktree = existsSync(join(DEPLOY_DIR, '.git'))
      ? await run('git', ['-C', DEPLOY_DIR, 'reset', '--hard', 'origin/main'], { env, shell: false })
      : await run('git', ['worktree', 'add', '--detach', DEPLOY_DIR, 'origin/main'], { env, shell: false });
    if (worktree.code !== 0) {
      console.error(worktree.output);
      return json(res, 500, { ok: false, message: '准备部署目录失败', log: worktree.output.slice(-4000) });
    }

    const lockfile = join(DEPLOY_DIR, 'package-lock.json');
    const stampPath = join(DEPLOY_DIR, 'node_modules', '.gdr-lock');
    const lockHash = existsSync(lockfile)
      ? createHash('sha1').update(readFileSync(lockfile)).digest('hex')
      : '';
    const installed = existsSync(stampPath) && readFileSync(stampPath, 'utf8').trim() === lockHash;

    if (installed) {
      console.log('[deploy] 依赖未变化，跳过 npm ci');
    } else {
      const install = await run('npm', ['ci'], { env, cwd: DEPLOY_DIR });
      if (install.code !== 0) {
        console.error(install.output);
        return json(res, 500, { ok: false, message: '安装依赖失败', log: install.output.slice(-4000) });
      }
      writeFileSync(stampPath, lockHash);
    }

    console.log('[deploy] npm run build（正式站只读 data/）');
    const build = await run('npm', ['run', 'build'], { env, cwd: DEPLOY_DIR });
    if (build.code !== 0) {
      console.error(build.output);
      return json(res, 500, { ok: false, message: '构建失败', log: build.output.slice(-4000) });
    }

    console.log('[deploy] wrangler pages deploy');
    const deployed = await run(
      'npx',
      ['--yes', WRANGLER, 'pages', 'deploy', 'dist', '--project-name', 'gdr-site', '--branch', 'main', '--commit-dirty=true'],
      { env, cwd: join(DEPLOY_DIR, 'site') },
    );

    if (deployed.code !== 0) {
      console.error(deployed.output);
      return json(res, 500, { ok: false, message: '部署失败', log: deployed.output.slice(-4000) });
    }
    return json(res, 200, { ok: true, message: '展示站已更新', log: deployed.output.slice(-2000) });
  } finally {
    deploying = false;
  }
}

async function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok: false, message: 'Method Not Allowed' });
  const pathname = decodeURIComponent(url.pathname);
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = normalize(join(ADMIN_DIR, relative));
  if (!full.startsWith(ADMIN_DIR)) return json(res, 403, { ok: false, message: 'Forbidden' });

  try {
    const info = await stat(full);
    if (!info.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(full).pipe(res);
  } catch {
    json(res, 404, { ok: false, message: 'Not Found' });
  }
}

function detectSystemProxy() {
  const envProxy = process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy;
  if (envProxy) return envProxy;
  if (process.platform !== 'win32') return null;
  try {
    const output = execFileSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { encoding: 'utf8', windowsHide: true });
    if (!/ProxyEnable\s+REG_DWORD\s+0x1/i.test(output)) return null;
    const match = output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/i);
    if (!match) return null;
    const raw = match[1].trim();
    const scoped = raw.match(/https=([^;\s]+)/i) || raw.match(/http=([^;\s]+)/i);
    const server = scoped ? scoped[1] : raw.split(';')[0];
    if (!server) return null;
    return /^https?:\/\//i.test(server) ? server : `http://${server}`;
  } catch {
    return null;
  }
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${HOST}`);
  if (url.pathname.startsWith('/api/admin/')) return proxy(req, res, url);
  if (url.pathname === '/api/local/deploy' && req.method === 'POST') return deploySite(req, res);
  if (url.pathname === '/api/local/status') {
    const secrets = findSecrets();
    return json(res, 200, {
      ok: true,
      deploy: Boolean(secrets?.vars.CLOUDFLARE_API_TOKEN),
      secrets: secrets?.path || null,
    });
  }
  return serveStatic(req, res, url);
});

function listen(port, attempts) {
  server.once('error', error => {
    if (error.code === 'EADDRINUSE' && attempts > 0) {
      console.warn(`端口 ${port} 被占用，尝试 ${port + 1}`);
      setTimeout(() => listen(port + 1, attempts - 1), 50);
      return;
    }
    console.error(error);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}/`;
    console.log(`本地审核控制台已启动：${url}`);
    console.log('关闭窗口或按 Ctrl+C 停止。');
    if (!process.env.ADMIN_NO_OPEN) openBrowser(url);
  });
}

if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error('需要 Node.js 18 或更高版本。');
  process.exit(1);
}

const proxyUrl = detectSystemProxy();
if (proxyUrl && !process.env.GDR_ADMIN_PROXY_ACTIVE) {
  if (Number(process.versions.node.split('.')[0]) >= 24) {
    console.log(`检测到系统代理 ${proxyUrl}，本地服务将通过代理访问审核 API。`);
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      stdio: 'inherit',
      env: {
        ...process.env,
        GDR_ADMIN_PROXY_ACTIVE: '1',
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: proxyUrl,
        HTTPS_PROXY: proxyUrl,
      },
    });
    child.on('exit', code => process.exit(code ?? 0));
  } else {
    console.warn(`检测到系统代理 ${proxyUrl}，但当前 Node 版本不支持自动使用代理，建议升级到 Node.js 24 或更高版本。`);
    listen(BASE_PORT, 10);
  }
} else {
  listen(BASE_PORT, 10);
}
