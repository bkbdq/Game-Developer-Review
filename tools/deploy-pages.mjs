import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

const project = option('project');
const assets = option('assets');
const functions = option('functions');
const branch = option('branch') || 'main';

if (!project || !assets) {
  console.error('用法：node tools/deploy-pages.mjs --project <名称> --assets <目录> [--functions <目录>] [--branch <分支>]');
  process.exit(1);
}

const assetsDir = resolve(root, assets);
const functionsDir = functions ? resolve(root, functions) : null;
if (!existsSync(assetsDir)) {
  console.error(`静态目录不存在：${assetsDir}`);
  process.exit(1);
}
if (functionsDir && !existsSync(functionsDir)) {
  console.error(`Functions 目录不存在：${functionsDir}`);
  process.exit(1);
}

// Cloudflare Pages 直接上传只识别部署目录内的 functions/，先合并到临时目录再上传
const stageDir = join(root, '.deploy-tmp', project);
rmSync(stageDir, { recursive: true, force: true });
mkdirSync(stageDir, { recursive: true });
cpSync(assetsDir, stageDir, { recursive: true });
if (functionsDir) cpSync(functionsDir, join(stageDir, 'functions'), { recursive: true });

const result = spawnSync(
  'npx',
  ['--yes', 'wrangler@4.165.0', 'pages', 'deploy', '.',
    '--project-name', project, '--branch', branch, '--commit-dirty=true'],
  { stdio: 'inherit', env: process.env, shell: true, cwd: stageDir },
);

rmSync(stageDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
