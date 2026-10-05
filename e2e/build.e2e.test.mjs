// build Builder 验收：真实 Architect 调度 + 普通静态服务器 + 真实浏览器。
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  createTempWorkspace,
  launchBrowser,
  openPage,
  repoRoot,
  runBuildOnce,
  runNgCli,
  startStaticServer,
  waitForText,
} from './helpers.mjs';

let browser;
before(async () => (browser = await launchBrowser()));
after(async () => browser?.close());

/** 在浏览器中走一遍应用的核心交互（A03 A04 A05 A06 A13） */
async function exerciseApp(url, { envName, devMode }) {
  const { page, errors } = await openPage(browser, url);
  await waitForText(page, '#lib-greeting', 'Hello, Angular! (from partial-Ivy lib)'); // A03 partial-Ivy 组件
  assert.equal(await page.textContent('#env-name'), envName); // A11 文件替换
  assert.equal(await page.textContent('#dev-mode'), String(devMode)); // A13 生产模式

  await page.click('#increment'); // A04 事件 + 信号
  await page.click('#increment');
  await waitForText(page, '#count', '2');
  await waitForText(page, '#double', '4');
  await page.fill('#name-input', 'Rollup'); // A04 表单 + 输入绑定
  await waitForText(page, '#lib-greeting', 'Hello, Rollup!');

  await page.click('#defer-trigger'); // A06 @defer
  await page.waitForSelector('#deferred-content');

  await page.click('#nav-lazy'); // A05 懒加载路由 + 库服务 DI
  await waitForText(page, '#lazy-message', 'Hello, lazy!');
  const dot = await page.$eval('#dot-box', (el) => getComputedStyle(el).backgroundImage);
  assert.match(dot, /media\/dot-[\w-]+\.svg/); // 组件 CSS url() 改写（官方构建的哈希格式不同）
  const banner = await page.$eval('.global-banner', (el) => getComputedStyle(el).backgroundImage);
  assert.match(banner, /media\/stripe-[\w-]+\.svg/); // 全局 CSS url() 改写
  assert.equal(await page.$eval('body', (el) => getComputedStyle(el).backgroundColor), 'rgb(250, 250, 245)'); // @import 内联

  const logoLoaded = await page.$eval('img.logo', (img) => img.complete && img.naturalWidth > 0);
  assert.ok(logoLoaded, 'public/ 资源可访问');

  await page.goto(new URL('lazy/detail', url).href); // A05 直接打开深层路由
  await page.waitForSelector('#lazy-detail-title');

  assert.equal(
    await page.evaluate(() => typeof globalThis.__polyfillLoadedAt),
    'number',
    'polyfills 先于应用执行',
  ); // A13
  assert.deepEqual(errors, []);
  await page.close();
}

describe('build Builder', () => {
  test('A01/A03-A06/A13 生产构建可由普通静态服务器访问', async () => {
    const result = await runBuildOnce(repoRoot, 'basic-app:build-rollup:production');
    assert.equal(result.success, true, result.error);

    const out = path.join(repoRoot, 'dist/basic-app-rollup');
    const files = readdirSync(out);
    assert.ok(files.some((f) => /^main-[\w-]{8}\.js$/.test(f)), '入口带内容哈希');
    assert.ok(files.some((f) => /^styles-[0-9a-f]{8}\.css$/.test(f)), '样式带内容哈希');
    assert.ok(!files.some((f) => f.endsWith('.map')), 'sourceMap=false 时不输出 map');
    const html = readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.match(html, /<meta name="description" content="业务 meta：构建器必须原样保留">/);
    assert.ok(html.indexOf('polyfills-') < html.indexOf('main-'), 'polyfills 脚本在 main 之前');

    const server = await startStaticServer(out);
    try {
      await exerciseApp(server.url, { envName: 'production', devMode: false });
    } finally {
      await server.close();
    }
  });

  test('A10 baseHref=/demo/ 子路径部署', async () => {
    const result = await runBuildOnce(repoRoot, 'basic-app:build-rollup:subpath');
    assert.equal(result.success, true, result.error);
    const out = path.join(repoRoot, 'dist/basic-app-rollup-demo');
    assert.match(readFileSync(path.join(out, 'index.html'), 'utf8'), /<base href="\/demo\/">/);

    const server = await startStaticServer(out, { baseHref: '/demo/' });
    try {
      // subpath 配置没有文件替换，因此 env 为 development；optimization=true 因此 devMode=false
      await exerciseApp(server.url, { envName: 'development', devMode: false });
    } finally {
      await server.close();
    }
  });

  test('A11/A12 开发构建：文件替换不生效、输出 Source Map 并指向源 TS', async () => {
    const result = await runBuildOnce(repoRoot, 'basic-app:build-rollup:development');
    assert.equal(result.success, true, result.error);
    const out = path.join(repoRoot, 'dist/basic-app-rollup');
    assert.ok(existsSync(path.join(out, 'main.js.map')));
    const map = JSON.parse(readFileSync(path.join(out, 'main.js.map'), 'utf8'));
    const appIndex = map.sources.findIndex((s) => s.endsWith('fixtures/basic-app/src/app/app.ts'));
    assert.ok(appIndex >= 0, 'sources 包含源 app.ts');
    assert.match(map.sourcesContent[appIndex], /protected readonly envName = environment\.name;/, '包含原始 TS 源码');

    const server = await startStaticServer(out);
    try {
      await exerciseApp(server.url, { envName: 'development', devMode: true });
    } finally {
      await server.close();
    }
  });

  test('A13 zone.js 应用：模块说明符 polyfill 先加载，zone 变更检测正常', async () => {
    const ws = createTempWorkspace('zone');
    try {
      ws.updateTarget('build-rollup', (t) => {
        t.options.polyfills = ['zone.js', 'fixtures/basic-app/src/polyfills.ts'];
      });
      ws.edit('src/app/app.config.ts', 'provideZonelessChangeDetection()', 'provideZoneChangeDetection({ eventCoalescing: true })');
      ws.edit('src/app/app.config.ts', 'provideZonelessChangeDetection }', 'provideZoneChangeDetection }');
      const result = await runBuildOnce(ws.root, 'basic-app:build-rollup:production');
      assert.equal(result.success, true, result.error);

      const server = await startStaticServer(path.join(ws.root, 'dist/basic-app-rollup'));
      try {
        const { page, errors } = await openPage(browser, server.url);
        await waitForText(page, '#lib-greeting', 'Hello, Angular!');
        assert.equal(await page.evaluate(() => typeof globalThis.Zone), 'function', 'zone.js 已加载');
        await page.click('#increment');
        await waitForText(page, '#count', '1');
        assert.deepEqual(errors, []);
        await page.close();
      } finally {
        await server.close();
      }
    } finally {
      ws.dispose();
    }
  });

  test('A19 通过工作区链接的库不会带来第二份 Angular 运行时', async () => {
    // @acme/greeting-lib 是 npm workspace 的符号链接，真实路径在 node_modules 之外
    const result = await runBuildOnce(repoRoot, 'basic-app:build-rollup:development');
    assert.equal(result.success, true, result.error);
    const out = path.join(repoRoot, 'dist/basic-app-rollup');
    const js = readdirSync(out).filter((f) => f.endsWith('.js')).map((f) => readFileSync(path.join(out, f), 'utf8')).join('\n');
    assert.equal(js.match(/^function ɵɵdefineComponent\(/gm)?.length, 1, '@angular/core 只打包一份');
    assert.match(js, /from partial-Ivy lib/, '链接库已被打包');
  });

  test('A11 文件替换同时作用于类型检查与打包（替换文件带有额外导出）', async () => {
    const ws = createTempWorkspace('文件替换');
    try {
      ws.write('src/environments/environment.prod.ts', ws.read('src/environments/environment.prod.ts') + "\nexport const onlyInProd = 'prod-only-export';\n");
      ws.edit('src/app/app.ts', "import { environment } from '../environments/environment';", "import { environment, onlyInProd } from '../environments/environment';");
      ws.edit('src/app/app.ts', 'protected readonly envName = environment.name;', 'protected readonly envName = `${environment.name}/${onlyInProd}`;');

      // 生产配置：类型检查看到的是替换文件 → 通过；打包使用的也是替换文件 → 页面显示其值
      const prod = await runBuildOnce(ws.root, 'basic-app:build-rollup:production');
      assert.equal(prod.success, true, prod.error);
      const server = await startStaticServer(path.join(ws.root, 'dist/basic-app-rollup'));
      try {
        const { page } = await openPage(browser, server.url);
        await waitForText(page, '#env-name', 'production/prod-only-export');
        await page.close();
      } finally {
        await server.close();
      }

      // 开发配置没有替换：原文件没有 onlyInProd → 类型检查必须失败
      const dev = await runBuildOnce(ws.root, 'basic-app:build-rollup:development');
      assert.equal(dev.success, false);
      assert.match(dev.error, /TS2305|onlyInProd/);
    } finally {
      ws.dispose();
    }
  });

  test('A24 对照：官方 application Builder 产物通过同一套浏览器检查', async () => {
    const result = await runBuildOnce(repoRoot, 'basic-app:build:production');
    assert.equal(result.success, true, result.error);
    const server = await startStaticServer(path.join(repoRoot, 'dist/basic-app-official/browser'));
    try {
      await exerciseApp(server.url, { envName: 'production', devMode: false });
    } finally {
      await server.close();
    }
  });

  test('A20 dev/prod 并发构建互不污染', async () => {
    const ws = createTempWorkspace('并发');
    try {
      ws.updateTarget('build-rollup', (target) => {
        target.configurations.development.outputPath = 'dist/dev-out';
        target.configurations.production.outputPath = 'dist/prod-out';
      });
      const [dev, prod] = await Promise.all([
        runBuildOnce(ws.root, 'basic-app:build-rollup:development'),
        runBuildOnce(ws.root, 'basic-app:build-rollup:production'),
      ]);
      assert.equal(dev.success, true, dev.error);
      assert.equal(prod.success, true, prod.error);
      assert.ok(existsSync(path.join(ws.root, 'dist/dev-out/main.js')));
      assert.ok(!readdirSync(path.join(ws.root, 'dist/prod-out')).includes('main.js'));
      assert.ok(!readdirSync(path.join(ws.root, 'dist')).some((d) => d.includes('.ngr-')), '无残留临时目录');
    } finally {
      ws.dispose();
    }
  });

  test('A02 TS 错误与模板类型错误：失败退出、定位源码、不发布新产物', async () => {
    const ws = createTempWorkspace('诊断');
    try {
      const ok = await runNgCli(ws.root, ['run', 'basic-app:build-rollup:development']);
      assert.equal(ok.code, 0, ok.output);
      const mainJs = path.join(ws.root, 'dist/basic-app-rollup/main.js');
      const before = statSync(mainJs).mtimeMs;

      ws.edit('src/app/app.ts', 'protected readonly devMode = isDevMode();', 'protected readonly devMode: number = isDevMode();');
      const tsError = await runNgCli(ws.root, ['run', 'basic-app:build-rollup:development']);
      assert.notEqual(tsError.code, 0);
      assert.match(tsError.output, /app\.ts[:(]\d+[:,]\d+/);
      assert.match(tsError.output, /TS2322/);
      assert.equal(statSync(mainJs).mtimeMs, before, '失败构建不触碰输出目录');

      ws.edit('src/app/app.ts', 'protected readonly devMode: number = isDevMode();', 'protected readonly devMode = isDevMode();');
      ws.edit('src/app/app.html', '{{ envName }}', '{{ envName.notAProperty() }}');
      const templateError = await runNgCli(ws.root, ['run', 'basic-app:build-rollup:development']);
      assert.notEqual(templateError.code, 0);
      assert.match(templateError.output, /app\.html[:(]\d+[:,]\d+/);
      assert.match(templateError.output, /notAProperty/);
    } finally {
      ws.dispose();
    }
  });

  test('A23 不支持的配置被明确拒绝', async () => {
    const ws = createTempWorkspace('拒绝');
    try {
      ws.updateTarget('build-rollup', (t) => (t.options.extractLicenses = true));
      const unknown = await runBuildOnce(ws.root, 'basic-app:build-rollup:development');
      assert.equal(unknown.success, false);
      assert.match(unknown.error, /extractLicenses/);

      ws.updateTarget('build-rollup', (t) => {
        delete t.options.extractLicenses;
        t.options.styles = ['fixtures/basic-app/src/theme.scss'];
      });
      ws.write('src/theme.scss', '$c: red; body { color: $c; }');
      const scss = await runBuildOnce(ws.root, 'basic-app:build-rollup:development');
      assert.equal(scss.success, false);
      assert.match(scss.error, /不支持的样式格式 "\.scss"/);

      ws.updateTarget('build-rollup', (t) => {
        t.options.styles = ['fixtures/basic-app/src/styles.css'];
        t.options.outputPath = 'fixtures';
      });
      const unsafe = await runBuildOnce(ws.root, 'basic-app:build-rollup:development');
      assert.equal(unsafe.success, false);
      assert.match(unsafe.error, /outputPath "fixtures" 不安全/);

      ws.updateTarget('build-rollup', (t) => (t.options.outputPath = 'dist/x'));
      ws.updateTarget('serve-rollup', (t) => (t.options.hmr = true));
      const hmr = await runBuildOnce(ws.root, 'basic-app:serve-rollup:development');
      assert.equal(hmr.success, false);
      assert.match(hmr.error, /不支持 HMR/);

      ws.updateTarget('serve-rollup', (t) => {
        delete t.options.hmr;
        t.configurations.development.buildTarget = 'basic-app:build:development';
      });
      const foreign = await runBuildOnce(ws.root, 'basic-app:serve-rollup:development');
      assert.equal(foreign.success, false);
      assert.match(foreign.error, /只支持 "@acme\/angular-rollup-builder:build"/);
    } finally {
      ws.dispose();
    }
  });
});
