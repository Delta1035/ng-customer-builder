// dev-server Builder 验收：watch、整页刷新、错误恢复、HTTP 行为、生命周期。
// 所有测试在临时工作区（路径含空格与中文）中修改源码。
import assert from 'node:assert/strict';
import net from 'node:net';
import { renameSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { createTempWorkspace, delay, httpGet, launchBrowser, openPage, scheduleTarget, waitForText } from './helpers.mjs';

let browser;
before(async () => (browser = await launchBrowser()));
after(async () => browser?.close());

/** 持续读取 dev-server 输出，直到满足条件（跳过中间可能出现的额外构建） */
async function untilOutput(run, predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const output = await run.nextOutput(deadline - Date.now());
    if (predicate(output)) return output;
  }
  throw new Error(`未等到期望的构建输出：${label}`);
}

describe('dev-server Builder', () => {
  const ws = createTempWorkspace('开发服务');
  let run;
  let baseUrl;
  let page;
  let pageErrors;

  after(async () => {
    await page?.close();
    await run?.stop();
    ws.dispose();
  });

  test('A14 首次编译失败 → 503 错误页 → 修复后自动恢复', async () => {
    ws.edit('src/app/app.ts', 'protected readonly devMode = isDevMode();', 'protected readonly devMode: number = isDevMode();');
    run = await scheduleTarget(ws.root, 'basic-app:serve-rollup:development', { port: 0 });
    const first = await run.nextOutput();
    assert.equal(first.success, false);
    assert.match(first.error, /TS2322/);
    baseUrl = first.baseUrl;

    const status = await httpGet(baseUrl);
    assert.equal(status.status, 503, '首次失败不返回未知旧产物');
    assert.match(status.body, /构建失败/);
    assert.match(status.body, /TS2322/);

    ({ page, errors: pageErrors } = await openPage(browser, baseUrl));
    ws.edit('src/app/app.ts', 'protected readonly devMode: number = isDevMode();', 'protected readonly devMode = isDevMode();');
    await untilOutput(run, (o) => o.success, '修复后成功');
    await waitForText(page, '#title', 'Rollup Builder Demo'); // 错误页自动刷新为应用
    await waitForText(page, '#dev-mode', 'true');
  });

  test('A07 修改外部模板、内联模板、组件 CSS 后页面更新', async () => {
    ws.edit('src/app/app.html', 'Rollup Builder Demo', 'Rollup Builder Demo v2');
    await waitForText(page, '#title', 'Demo v2');

    ws.edit('src/app/home.ts', '加载延迟块</button>', '加载延迟块 v2</button>');
    await waitForText(page, '#defer-trigger', '加载延迟块 v2');

    ws.edit('src/app/app.css', 'color: rgb(25, 118, 210);', 'color: rgb(200, 0, 0);');
    await page.waitForFunction(() => getComputedStyle(document.querySelector('h1')).color === 'rgb(200, 0, 0)');
  });

  test('A08/A09 全局 CSS、传递 @import、样式引用的资源、删除 public 资源', async () => {
    ws.edit('src/theme.css', '--page-bg: rgb(250, 250, 245);', '--page-bg: rgb(1, 2, 3);'); // styles.css @import 的文件
    await page.waitForFunction(() => getComputedStyle(document.body).backgroundColor === 'rgb(1, 2, 3)');

    await page.click('#nav-lazy');
    await page.waitForSelector('#dot-box');
    const before = await page.$eval('#dot-box', (el) => getComputedStyle(el).backgroundImage);
    ws.write('src/assets/dot.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="#f00"/></svg>');
    // dot.svg 只被 lazy-page.css 的 url() 引用：依赖图必须让该组件样式重新处理
    await page.waitForFunction(
      (old) => {
        const el = document.querySelector('#dot-box');
        return el && getComputedStyle(el).backgroundImage !== old;
      },
      before,
      { timeout: 30_000 },
    );
    const after = await page.$eval('#dot-box', (el) => getComputedStyle(el).backgroundImage);
    assert.equal((await httpGet(after.match(/url\("(.+)"\)/)[1])).status, 200);

    assert.equal((await httpGet(`${baseUrl}images/logo.svg`)).status, 200);
    ws.remove('public/images/logo.svg');
    await eventually(async () => (await httpGet(`${baseUrl}images/logo.svg`)).status === 404, '删除的资源不再被旧文件掩盖');
  });

  test('A15 运行中编译失败 → 错误浮层、保留最后成功版本 → 修复后更新', async () => {
    // 上一个用例的最后一次重建可能恰好触发整页刷新，打断这次导航；那是预期行为，重试即可
    await eventually(() => page.goto(baseUrl).then(() => true, () => false), '打开首页');
    await waitForText(page, '#title', 'Demo v2');
    ws.edit('src/app/app.html', '{{ envName }}', '{{ envName.notAProperty() }}');
    const failed = await untilOutput(run, (o) => !o.success, '模板错误');
    assert.match(failed.error, /notAProperty/);

    await page.waitForSelector('#ng-rollup-error-overlay');
    assert.match(await page.textContent('#ng-rollup-error-overlay'), /notAProperty/);
    assert.equal((await httpGet(`${baseUrl}main.js`)).status, 200, '最后成功版本仍可访问');

    ws.edit('src/app/app.html', '{{ envName.notAProperty() }}', '{{ envName }} (fixed)');
    await waitForText(page, '#env-name', 'development');
    await page.waitForFunction(() => document.body.textContent.includes('(fixed)'));
    assert.equal(await page.$('#ng-rollup-error-overlay'), null);
  });

  test('A16 快速连续保存、新增/重命名/删除文件', async () => {
    for (let i = 1; i <= 5; i++) {
      ws.edit('src/app/app.html', i === 1 ? 'Demo v2' : `Demo r${i - 1}`, `Demo r${i}`);
      await delay(30);
    }
    await waitForText(page, '#title', 'Demo r5');

    ws.write('src/app/extra.ts', "export const EXTRA = 'extra-one';\n");
    ws.edit('src/app/app.ts', "import { environment } from '../environments/environment';", "import { environment } from '../environments/environment';\nimport { EXTRA } from './extra';");
    ws.edit('src/app/app.ts', 'protected readonly envName = environment.name;', 'protected readonly envName = environment.name + EXTRA;');
    await waitForText(page, '#env-name', 'developmentextra-one');

    renameSync(ws.app('src/app/extra.ts'), ws.app('src/app/extra-renamed.ts'));
    ws.edit('src/app/app.ts', "from './extra';", "from './extra-renamed';");
    ws.edit('src/app/extra-renamed.ts', 'extra-one', 'extra-two');
    await waitForText(page, '#env-name', 'developmentextra-two');

    // 删除被引用的文件 → 编译失败（而不是继续使用内存中的旧编译结果）
    ws.remove('src/app/extra-renamed.ts');
    await untilOutput(run, (o) => !o.success && /extra-renamed/.test(o.error), '删除被引用文件');
    ws.edit('src/app/app.ts', "import { EXTRA } from './extra-renamed';\n", '');
    ws.edit('src/app/app.ts', 'environment.name + EXTRA;', 'environment.name;');
    await page.waitForFunction(
      () => {
        const text = document.querySelector('#env-name')?.textContent ?? '';
        return text.startsWith('development') && !text.includes('extra');
      },
      null,
      { timeout: 30_000 },
    );
  });

  test('A15 组件样式引用缺失资源 → 失败 → 补上资源后使用新样式恢复（而不是旧分析结果）', async () => {
    ws.edit('src/app/lazy/lazy-page.css', "url('../../assets/dot.svg')", "url('../../assets/new-dot.svg')");
    await untilOutput(run, (o) => !o.success && /new-dot\.svg/.test(o.error), '引用缺失资源');

    ws.write('src/assets/new-dot.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="8" fill="#0a0"/></svg>');
    await eventually(() => page.goto(`${baseUrl}lazy`).then(() => true, () => false), '打开懒加载页');
    await page.waitForFunction(
      () => {
        const el = document.querySelector('#dot-box');
        return el && getComputedStyle(el).backgroundImage.includes('new-dot');
      },
      null,
      { timeout: 30_000 },
    );
  });

  test('A18 缺失 JS、API 请求、越界路径不返回 SPA HTML', async () => {
    const html = { accept: 'text/html' };
    const deep = await httpGet(`${baseUrl}lazy/detail`, html);
    assert.equal(deep.status, 200);
    assert.match(deep.type, /text\/html/);

    assert.equal((await httpGet(`${baseUrl}missing-chunk.js`, html)).status, 404);
    assert.equal((await httpGet(`${baseUrl}missing.css`, html)).status, 404);
    assert.equal((await httpGet(`${baseUrl}api/users`, { accept: 'application/json' })).status, 404);
    for (const probe of ['..%2f..%2fangular.json', '%2e%2e/%2e%2e/package.json', 'src/app/app.ts', '..%5c..%5cangular.json']) {
      const response = await httpGet(`${baseUrl}${probe}`);
      assert.ok([400, 404].includes(response.status), `${probe} → ${response.status}`);
      assert.doesNotMatch(response.body, /"projects"|"name": "e2e-temp"|isDevMode/);
    }
    const js = await httpGet(`${baseUrl}main.js`);
    assert.match(js.type, /text\/javascript/);
  });

  test('A21 配置变化：tsconfig 重新初始化，angular.json 明确要求重启', async () => {
    ws.edit('tsconfig.app.json', '"types": []', '"types": [],\n    "noUnusedLocals": false');
    await untilOutput(run, (o) => o.success, 'tsconfig 修改后重新初始化');

    ws.updateTarget('serve-rollup', (t) => (t.options.liveReload = true));
    const restart = await untilOutput(run, (o) => !o.success, 'angular.json 修改');
    assert.match(restart.error, /angular\.json 已修改.*请重启/);
    assert.deepEqual(pageErrors.filter((e) => !/503|Failed to load resource/.test(e)), []);
  });
});

describe('dev-server 生命周期与子路径', () => {
  test('A17 stop 释放端口，端口占用时给出可操作错误', async () => {
    const ws = createTempWorkspace('生命周期');
    const port = await freePort();
    try {
      const first = await scheduleTarget(ws.root, 'basic-app:serve-rollup:development', { port });
      assert.equal((await first.nextOutput()).success, true);

      const conflict = await scheduleTarget(ws.root, 'basic-app:serve-rollup:development', { port });
      const conflictOutput = await conflict.nextOutput();
      assert.equal(conflictOutput.success, false);
      assert.match(conflictOutput.error, new RegExp(`端口 ${port} 已被占用`));
      await conflict.stop();

      await first.stop(); // Architect 停止任务 → teardown 关闭服务器、watcher、连接
      const again = await scheduleTarget(ws.root, 'basic-app:serve-rollup:development', { port });
      assert.equal((await again.nextOutput()).success, true, '同一端口可立即复用');
      await again.stop();
    } finally {
      ws.dispose();
    }
  });

  test('A10 dev-server 子路径 /demo/', async () => {
    const ws = createTempWorkspace('子路径');
    const run = await scheduleTarget(ws.root, 'basic-app:serve-rollup:subpath', { port: 0 });
    try {
      const output = await run.nextOutput();
      assert.equal(output.success, true, output.error);
      assert.match(output.baseUrl, /\/demo\/$/);
      const origin = new URL(output.baseUrl).origin;
      assert.equal((await httpGet(`${origin}/`)).status, 404);
      assert.equal((await httpGet(`${origin}/demo`)).status, 302);
      const index = await httpGet(output.baseUrl);
      assert.match(index.body, /data-events-url="\/demo\/__ng-rollup\/events"/);

      const { page, errors } = await openPage(browser, `${output.baseUrl}lazy`);
      await waitForText(page, '#lazy-message', 'Hello, lazy!');
      ws.edit('src/app/lazy/lazy-page.html', '懒加载页面', '懒加载页面 v2');
      await waitForText(page, '#lazy-title', '懒加载页面 v2'); // 通知连接在子路径下工作
      assert.deepEqual(errors, []);
      await page.close();
    } finally {
      await run.stop();
      ws.dispose();
    }
  });
});

/** 轮询直到条件成立：断言可观察的结果，而不是依赖构建输出的到达顺序 */
async function eventually(check, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(200);
  }
  throw new Error(`超时：${label}`);
}

function freePort() {
  return new Promise((resolve) => {
    const server = net.createServer().listen(0, 'localhost', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
