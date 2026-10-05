// 构建本包：tsc 编译 src → dist，然后把 schema.json 复制到 dist 中同样的位置。
// builders.json 指向 dist 里的实现与 schema，所以发布包只需要 dist + builders.json。
import { execFileSync } from 'node:child_process';
import { cpSync, globSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

rmSync(join(packageRoot, 'dist'), { recursive: true, force: true });

// 使用项目依赖中的 tsc，而不是全局安装的版本
const tsc = require.resolve('typescript/bin/tsc');
execFileSync(process.execPath, [tsc, '-p', join(packageRoot, 'tsconfig.json')], { stdio: 'inherit' });

for (const schema of globSync('src/**/schema.json', { cwd: packageRoot })) {
  const target = join(packageRoot, 'dist', schema.slice('src/'.length));
  mkdirSync(dirname(target), { recursive: true });
  cpSync(join(packageRoot, schema), target);
}

console.log('built @acme/angular-rollup-builder → dist/');
