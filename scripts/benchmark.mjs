// 验收 A24：与官方 application Builder 的耗时/体积对照。输出 Markdown 表格，结果记录在 docs/benchmarks.md。
//
// 测量内容：
//   冷构建  每次新启动 ng 进程执行生产构建，取中位数（含 CLI 启动开销）
//   体积    产物中 .js/.css 的原始与 gzip 大小
//   热重建  dev-server 运行中修改模板，到 Architect 收到新构建结果的耗时（仅自定义 Builder；
//           官方 dev-server 基于 Vite 按需编译，没有可比的「完整重建」事件，不做对比）
//
// 用法：node scripts/benchmark.mjs [--runs 3]
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createTempWorkspace, repoRoot, scheduleTarget } from '../e2e/helpers.mjs';

const runs = Number(process.argv[process.argv.indexOf('--runs') + 1]) || 3;
const ng = path.join(repoRoot, 'node_modules/@angular/cli/bin/ng.js');
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** clearCache：每次运行前删除官方 Builder 的持久缓存 .angular/cache（自定义 Builder 没有持久缓存） */
function coldBuild(target, { clearCache = false } = {}) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    if (clearCache) rmSync(path.join(repoRoot, '.angular/cache'), { recursive: true, force: true });
    const start = performance.now();
    execFileSync(process.execPath, [ng, 'run', target], { cwd: repoRoot, stdio: 'ignore', env: { ...process.env, NG_CLI_ANALYTICS: 'false' } });
    times.push(performance.now() - start);
  }
  return median(times);
}

function measureOutput(dir) {
  const files = [];
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(js|css)$/.test(entry)) files.push(full);
    }
  };
  walk(dir);
  let raw = 0;
  let gzip = 0;
  for (const file of files) {
    const contents = readFileSync(file);
    raw += contents.length;
    gzip += gzipSync(contents, { level: 9 }).length;
  }
  return { files: files.length, raw, gzip };
}

async function hotRebuild() {
  const ws = createTempWorkspace('benchmark');
  const run = await scheduleTarget(ws.root, 'basic-app:serve-rollup:development', { port: 0, liveReload: false });
  const coldStart = performance.now();
  try {
    await run.nextOutput();
    const initial = performance.now() - coldStart;
    const times = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      ws.edit('src/app/app.html', i === 0 ? 'Rollup Builder Demo' : `Demo ${i - 1}`, `Demo ${i}`);
      const output = await run.nextOutput();
      if (!output.success) throw new Error(output.error);
      times.push(performance.now() - start);
    }
    const tsTimes = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      ws.edit('src/app/app.ts', i === 0 ? 'environment.name;' : `environment.name + ${i - 1};`, `environment.name + ${i};`);
      const output = await run.nextOutput();
      if (!output.success) throw new Error(output.error);
      tsTimes.push(performance.now() - start);
    }
    return { initial, template: median(times), ts: median(tsTimes) };
  } finally {
    await run.stop();
    ws.dispose();
  }
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
const ms = (value) => `${Math.round(value)} ms`;

console.error(`冷构建测量中（每项 ${runs} 次）…`);
const officialNoCache = coldBuild('basic-app:build:production', { clearCache: true });
const officialCached = coldBuild('basic-app:build:production');
const rollupTime = coldBuild('basic-app:build-rollup:production');
const official = measureOutput(path.join(repoRoot, 'dist/basic-app-official/browser'));
const rollup = measureOutput(path.join(repoRoot, 'dist/basic-app-rollup'));
console.error('热重建测量中…');
const hot = await hotRebuild();

const versions = JSON.parse(readFileSync(path.join(repoRoot, 'node_modules/@angular/core/package.json'), 'utf8')).version;
console.log(`环境：${os.cpus()[0].model.trim()}，${os.cpus().length} 线程，${Math.round(os.totalmem() / 2 ** 30)} GB，${os.type()} ${os.release()}，Node ${process.version}，Angular ${versions}
测量方法：新进程完整执行 \`ng run\` 的墙钟时间中位数（${runs} 次，含 CLI 启动）；体积为 .js/.css 合计，gzip 使用 level 9。

| 指标 | 官方 @angular/build:application | @acme/angular-rollup-builder | 差异 |
| --- | --- | --- | --- |
| 生产构建（墙钟，清空 .angular/cache） | ${ms(officialNoCache)} | ${ms(rollupTime)} | ${((rollupTime / officialNoCache - 1) * 100).toFixed(0)}% |
| 生产构建（墙钟，官方使用持久缓存） | ${ms(officialCached)} | ${ms(rollupTime)}（无持久缓存） | ${((rollupTime / officialCached - 1) * 100).toFixed(0)}% |
| JS/CSS 文件数 | ${official.files} | ${rollup.files} | |
| JS/CSS 原始体积 | ${kb(official.raw)} | ${kb(rollup.raw)} | ${((rollup.raw / official.raw - 1) * 100).toFixed(1)}% |
| JS/CSS gzip 体积 | ${kb(official.gzip)} | ${kb(rollup.gzip)} | ${((rollup.gzip / official.gzip - 1) * 100).toFixed(1)}% |

| 自定义 dev-server（内存缓存，无持久缓存） | 耗时 |
| --- | --- |
| 首次构建（服务启动后） | ${ms(hot.initial)} |
| 修改外部模板 → 新构建可用（中位数，5 次） | ${ms(hot.template)} |
| 修改 TS 文件 → 新构建可用（中位数，5 次） | ${ms(hot.ts)} |`);
