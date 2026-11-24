import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const dir = resolve('.backups');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const output = resolve(dir, `goodcompany-${stamp}.sql`);
const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const args = ['--yes', 'wrangler@4.165.0', 'd1', 'export', 'goodcompany', '--remote', '--output', output];

console.log(`导出 D1 到 ${output}`);
const result = spawnSync(command, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
