// e2e 测试公共工具：真实 Architect 调度、真实浏览器、临时工作区、静态服务器。
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

// DevKit 包是 CommonJS 且使用目录导入，用 require 加载
const require = createRequire(import.meta.url);
const { Architect } = require('@angular-devkit/architect');
const { WorkspaceNodeModulesArchitectHost } = require('@angular-devkit/architect/node');
const { logging, schema, workspaces } = require('@angular-devkit/core');
const { NodeJsSyncHost } = require('@angular-devkit/core/node');

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ngBin = path.join(repoRoot, 'node_modules/@angular/cli/bin/ng.js');

// ---------------------------------------------------------------------------
// 临时工作区：复制示例应用，测试可以随意修改源码而不影响仓库。
// 目录名刻意包含空格与中文（验收 A19）。它位于仓库内，因此能向上解析到仓库的 node_modules。
// ---------------------------------------------------------------------------

export function createTempWorkspace(name) {
  const root = path.join(repoRoot, '.e2e-tmp', `临时 工作区 ${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(path.join(repoRoot, 'fixtures/basic-app'), path.join(root, 'fixtures/basic-app'), { recursive: true });
  for (const file of ['angular.json', 'tsconfig.json']) {
    cpSync(path.join(repoRoot, file), path.join(root, file));
  }
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'e2e-temp', private: true }));

  const app = (relative) => path.join(root, 'fixtures/basic-app', relative);
  return {
    root,
    app,
    read: (relative) => readFileSync(app(relative), 'utf8'),
    write: (relative, contents) => {
      mkdirSync(path.dirname(app(relative)), { recursive: true });
      writeFileSync(app(relative), contents);
    },
    edit: (relative, from, to) => {
      const original = readFileSync(app(relative), 'utf8');
      if (!original.includes(from)) throw new Error(`${relative} 中找不到 "${from}"`);
      writeFileSync(app(relative), original.replace(from, to));
    },
    remove: (relative) => rmSync(app(relative), { force: true }),
    /** 修改 angular.json 中 basic-app 的某个 target */
    updateTarget: (target, update) => {
      const file = path.join(root, 'angular.json');
      const json = JSON.parse(readFileSync(file, 'utf8'));
      update(json.projects['basic-app'].architect[target]);
      writeFileSync(file, JSON.stringify(json, null, 2));
    },
    // Windows 上杀毒软件/索引服务可能短暂占用刚写入的文件：清理尽力而为，下次创建时会再删一次
    dispose: () => {
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch (error) {
        console.warn(`临时工作区清理失败（可忽略）：${error.message}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 真实 Architect 调度（与 ng run 使用同一套 API）
// ---------------------------------------------------------------------------

export async function scheduleTarget(workspaceRoot, targetString, overrides = {}) {
  const [project, target, configuration] = targetString.split(':');
  const { workspace } = await workspaces.readWorkspace(workspaceRoot, workspaces.createWorkspaceHost(new NodeJsSyncHost()));
  const registry = new schema.CoreSchemaRegistry();
  registry.addPostTransform(schema.transforms.addUndefinedDefaults);
  registry.useXDeprecatedProvider((message) => console.warn(message));
  const architect = new Architect(new WorkspaceNodeModulesArchitectHost(workspace, workspaceRoot), registry);

  const logger = new logging.Logger('e2e');
  const logs = [];
  logger.subscribe((entry) => logs.push(entry.message));

  const run = await architect.scheduleTarget({ project, target, configuration }, overrides, { logger });

  // 把 BuilderOutput 流转成「按需等待下一个结果」的队列
  const outputs = [];
  const waiters = [];
  const subscription = run.output.subscribe({
    next: (output) => (waiters.length ? waiters.shift()(output) : outputs.push(output)),
    error: (error) => waiters.splice(0).forEach((resolve) => resolve({ success: false, error: String(error) })),
  });

  return {
    logs,
    nextOutput(timeout = 120_000) {
      if (outputs.length) return Promise.resolve(outputs.shift());
      return withTimeout(new Promise((resolve) => waiters.push(resolve)), timeout, `等待 ${targetString} 输出`);
    },
    async stop() {
      subscription.unsubscribe();
      await run.stop();
    },
  };
}

/** 单次构建：等待第一个结果后结束 */
export async function runBuildOnce(workspaceRoot, targetString, overrides) {
  const run = await scheduleTarget(workspaceRoot, targetString, overrides);
  try {
    return { ...(await run.nextOutput()), logs: run.logs };
  } finally {
    await run.stop();
  }
}

/** 通过真实的 ng 命令行运行，用于检查进程退出码 */
export function runNgCli(cwd, args, timeout = 180_000) {
  return withTimeout(
    new Promise((resolve) => {
      const child = spawn(process.execPath, [ngBin, ...args], { cwd, env: { ...process.env, NG_CLI_ANALYTICS: 'false', FORCE_COLOR: '0' } });
      let output = '';
      child.stdout.on('data', (chunk) => (output += chunk));
      child.stderr.on('data', (chunk) => (output += chunk));
      child.on('close', (code) => resolve({ code, output }));
    }),
    timeout,
    `ng ${args.join(' ')}`,
  );
}

// ---------------------------------------------------------------------------
// 浏览器与 HTTP
// ---------------------------------------------------------------------------

/** 使用系统已安装的浏览器（默认 Edge；可通过 E2E_BROWSER_CHANNEL=chrome 切换），无需下载 */
export async function launchBrowser() {
  return chromium.launch({ channel: process.env.E2E_BROWSER_CHANNEL ?? 'msedge' });
}

export async function openPage(browser, url) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
  await page.goto(url);
  return { page, errors };
}

/** 等待某元素文本满足条件（自动重试，适配 zoneless 的异步变更检测） */
export async function waitForText(page, selector, expected, timeout = 30_000) {
  await page.waitForFunction(
    ([sel, text]) => document.querySelector(sel)?.textContent?.includes(text),
    [selector, expected],
    { timeout },
  );
}

/**
 * 最普通的静态文件服务器（模拟真实部署）：只做文件映射与 SPA fallback，
 * 用来证明构建产物不依赖我们的开发服务器。
 */
export function startStaticServer(root, { baseHref = '/', port = 0 } = {}) {
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.svg': 'image/svg+xml', '.map': 'application/json' };
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (!pathname.startsWith(baseHref)) {
      res.writeHead(404).end();
      return;
    }
    const relative = pathname.slice(baseHref.length) || 'index.html';
    let file = path.join(root, relative);
    if (!file.startsWith(root) || !existsSync(file) || relative.endsWith('/')) {
      if (path.extname(relative)) {
        res.writeHead(404).end();
        return;
      }
      file = path.join(root, 'index.html');
    }
    res.writeHead(200, { 'content-type': types[path.extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  return new Promise((resolve) =>
    server.listen(port, 'localhost', () => {
      resolve({ url: `http://localhost:${server.address().port}${baseHref}`, close: () => new Promise((r) => server.close(r)) });
    }),
  );
}

export async function httpGet(url, headers = {}) {
  const response = await fetch(url, { headers, redirect: 'manual' });
  return { status: response.status, type: response.headers.get('content-type') ?? '', body: await response.text() };
}

export function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`超时（${ms} ms）：${label}`)), ms))),
  ]);
}

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
