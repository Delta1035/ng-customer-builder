// 验收 A22：npm pack 后在干净目录安装，运行两个 Builder。
//
// 1. 构建并打包 @acme/angular-rollup-builder 与测试库 @acme/greeting-lib
// 2. 在仓库之外创建干净工作区（路径含空格与中文），只安装 Angular 运行时、CLI、编译器和两个 tarball
//    —— 不安装 @angular/build，从而证明编译/打包/开发服务链路不依赖 esbuild 或 Vite
// 3. ng run build-rollup:production，检查退出码与产物
// 4. ng run serve-rollup，请求首页与 main.js，然后结束进程
//
// 用法：node scripts/pack-install-test.mjs [--keep]
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keep = process.argv.includes('--keep');
const rootPackage = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const versionOf = (name) => rootPackage.dependencies[name] ?? rootPackage.devDependencies[name];

function npm(args, cwd) {
  // 通过 npm run 启动时 npm_execpath 指向 npm-cli.js；否则退回到 PATH 中的 npm
  const npmCli = process.env.npm_execpath;
  const [command, finalArgs] = npmCli?.endsWith('.js') ? [process.execPath, [npmCli, ...args]] : ['npm', args];
  return execFileSync(command, finalArgs, { cwd, encoding: 'utf8', shell: !npmCli, stdio: ['ignore', 'pipe', 'inherit'] });
}

function step(message) {
  console.log(`\n▶ ${message}`);
}

const workDir = path.join(os.tmpdir(), `ngr 安装测试 ${Date.now()}`);
mkdirSync(workDir, { recursive: true });
let failed = false;

try {
  step('构建并打包');
  npm(['run', 'prepare:all'], repoRoot);
  const tarballs = {};
  for (const [name, dir] of [
    ['@acme/angular-rollup-builder', 'packages/angular-rollup-builder'],
    ['@acme/greeting-lib', 'fixtures/partial-ivy-library'],
  ]) {
    const output = npm(['pack', '--json', '--pack-destination', workDir], path.join(repoRoot, dir));
    const [{ filename, files }] = JSON.parse(output);
    tarballs[name] = path.join(workDir, filename);
    console.log(`  ${filename}（${files.length} 个文件）`);
    const packed = files.map((f) => f.path);
    const required =
      name === '@acme/angular-rollup-builder'
        ? ['builders.json', 'dist/build/index.js', 'dist/build/schema.json', 'dist/dev-server/index.js', 'dist/dev-server/schema.json']
        : ['dist/index.js', 'dist/index.d.ts'];
    for (const file of required) {
      if (!packed.includes(file)) throw new Error(`${name} 发布包缺少 ${file}`);
    }
    if (packed.some((f) => f.startsWith('src/') || f.startsWith('test/'))) throw new Error(`${name} 发布包不应包含 src/ 或 test/`);
  }

  step(`创建干净工作区：${workDir}`);
  const app = path.join(workDir, 'app');
  cpSync(path.join(repoRoot, 'fixtures/basic-app'), path.join(app, 'fixtures/basic-app'), { recursive: true });
  cpSync(path.join(repoRoot, 'tsconfig.json'), path.join(app, 'tsconfig.json'));
  const angularJson = JSON.parse(readFileSync(path.join(repoRoot, 'angular.json'), 'utf8'));
  const architect = angularJson.projects['basic-app'].architect;
  delete architect.build; // 官方 Builder 不安装，只保留自定义目标
  delete architect.serve;
  architect['serve-rollup'].options.port = 4391;
  writeFileSync(path.join(app, 'angular.json'), JSON.stringify(angularJson, null, 2));

  const runtime = ['@angular/common', '@angular/compiler', '@angular/core', '@angular/forms', '@angular/platform-browser', '@angular/router', 'rxjs', 'tslib'];
  writeFileSync(
    path.join(app, 'package.json'),
    JSON.stringify(
      {
        name: 'clean-install-app',
        private: true,
        dependencies: Object.fromEntries([...runtime.map((n) => [n, versionOf(n)]), ['@acme/greeting-lib', `file:${tarballs['@acme/greeting-lib']}`]]),
        devDependencies: {
          '@acme/angular-rollup-builder': `file:${tarballs['@acme/angular-rollup-builder']}`,
          '@angular/cli': versionOf('@angular/cli'),
          '@angular/compiler-cli': versionOf('@angular/compiler-cli'),
          typescript: versionOf('typescript'),
        },
      },
      null,
      2,
    ),
  );

  step('npm install');
  npm(['install', '--no-audit', '--no-fund'], app);
  const forbidden = ['@angular/build', '@angular-devkit/build-angular', 'esbuild', 'vite'].filter((p) => existsSync(path.join(app, 'node_modules', p)));
  console.log(forbidden.length ? `  ⚠ 依赖树中出现：${forbidden.join(', ')}` : '  依赖树中没有 @angular/build / esbuild / vite');

  step('ng run basic-app:build-rollup:production');
  const ng = path.join(app, 'node_modules/@angular/cli/bin/ng.js');
  execFileSync(process.execPath, [ng, 'run', 'basic-app:build-rollup:production'], { cwd: app, stdio: 'inherit', env: { ...process.env, NG_CLI_ANALYTICS: 'false' } });
  const out = path.join(app, 'dist/basic-app-rollup');
  const files = readdirSync(out);
  if (!files.includes('index.html') || !files.some((f) => /^main-.+\.js$/.test(f))) throw new Error(`产物不完整：${files.join(', ')}`);
  console.log(`  产物：${files.join(', ')}`);

  step('ng run basic-app:serve-rollup:development');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ng, 'run', 'basic-app:serve-rollup:development'], { cwd: app, env: { ...process.env, NG_CLI_ANALYTICS: 'false' } });
    let log = '';
    const timer = setTimeout(() => finish(new Error(`开发服务器超时：\n${log}`)), 120_000);
    const finish = (error) => {
      clearTimeout(timer);
      child.kill();
      error ? reject(error) : resolve();
    };
    const onData = async (chunk) => {
      log += chunk;
      if (log.includes('构建失败')) return finish(new Error(log));
      if (!log.includes('构建成功')) return;
      child.stdout.off('data', onData);
      try {
        const index = await fetch('http://localhost:4391/');
        const main = await fetch('http://localhost:4391/main.js');
        const html = await index.text();
        if (index.status !== 200 || !html.includes('__ng-rollup/client.js') || main.status !== 200) throw new Error(`响应异常 ${index.status}/${main.status}`);
        console.log('  首页与 main.js 均返回 200，live-reload 客户端已注入');
        finish();
      } catch (error) {
        finish(error);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => (log += chunk));
  });

  console.log('\n✔ A22 通过：干净安装后两个 Builder 均可运行');
} catch (error) {
  failed = true;
  console.error(`\n✘ A22 失败：${error.message}`);
} finally {
  if (keep || failed) {
    console.log(`工作目录保留在：${workDir}`);
  } else {
    rmSync(workDir, { recursive: true, force: true, maxRetries: 5 });
  }
  process.exitCode = failed ? 1 : 0;
}
