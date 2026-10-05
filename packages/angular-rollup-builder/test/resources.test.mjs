// 资源处理单元测试：CSS 处理、index.html 生成、静态资源收集。
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { processCss } = require('../dist/resources/css-processor.js');
const { generateIndexHtml, injectBeforeBodyEnd } = require('../dist/resources/index-html.js');
const { collectAssets } = require('../dist/resources/assets.js');

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ngr 资源 '));
after(() => rmSync(tmp, { recursive: true, force: true }));
const file = (relative, contents) => {
  const target = path.join(tmp, relative);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
  return target;
};

describe('processCss', () => {
  test('内联 @import（含空格路径）、改写相对 url()、保留外部 url', () => {
    file('styles/fonts/a b.woff2', 'font');
    file('styles/theme.css', '.t { background: url("./fonts/a b.woff2?#iefix"); }');
    const entry = file('styles/main.css', [
      "@import 'https://fonts.example.com/x.css';",
      '@import "./theme.css";',
      '.a { background: url(data:image/png;base64,AAA); }',
      '.b { background: url(#frag); mask: url(/abs.svg); }',
    ].join('\n'));

    const result = processCss(require('node:fs').readFileSync(entry, 'utf8'), entry);
    assert.match(result.css, /^@import 'https:\/\/fonts\.example\.com\/x\.css';/, '远程 @import 提升到最前');
    assert.match(result.css, /url\("media\/a b-[0-9a-f]{8}\.woff2\?#iefix"\)/, 'url 相对被内联文件解析，并保留后缀');
    assert.match(result.css, /url\(data:image\/png;base64,AAA\)/);
    assert.match(result.css, /url\(#frag\)/);
    assert.match(result.css, /url\(\/abs\.svg\)/);
    assert.ok([...result.dependencies].some((d) => d.endsWith('theme.css')));
    assert.ok([...result.dependencies].some((d) => d.endsWith('a b.woff2')));
    assert.equal(result.assets.length, 1);
  });

  test('带媒体查询的 @import 包进 @media', () => {
    file('m/print.css', '.p { color: red; }');
    const entry = file('m/main.css', '@import url(print.css) print;');
    const { css } = processCss("@import url(print.css) print;", entry);
    assert.match(css, /@media print\s*\{\s*\.p \{ color: red; \}\s*\}/);
  });

  test('缺失的文件、循环 @import、无法解析的 @import 都明确报错', () => {
    const entry = file('e/main.css', '');
    assert.throws(() => processCss('.x { background: url(./missing.png); }', entry), /missing\.png.*不存在/);
    assert.throws(() => processCss('@import "./missing.css";', entry), /missing\.css.*不存在/);
    file('e/a.css', '@import "./b.css";');
    file('e/b.css', '@import "./a.css";');
    assert.throws(() => processCss('@import "./a.css";', entry), /循环 @import/);
    assert.throws(() => processCss('@import foo bar;', entry), /无法解析 @import/);
  });

  test('Windows 盘符路径不会被当作 URL 协议', () => {
    const target = file('w/x.css', '.w { color: blue; }');
    const entry = file('w/main.css', '');
    const { css } = processCss(`@import "${target.replace(/\\/g, '/')}";`, entry);
    assert.match(css, /\.w \{ color: blue; \}/);
  });
});

describe('generateIndexHtml', () => {
  const template = `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <base href="/">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self'">
  <!-- 业务注释 -->
</head>
<body><app-root></app-root>
<script src="existing.js"></script>
</body>
</html>`;

  test('替换 base href、注入样式与脚本、原样保留其余内容', async () => {
    const html = await generateIndexHtml(template, {
      baseHref: '/demo/',
      scripts: ['polyfills.js', 'main.js', 'existing.js'],
      stylesheets: ['styles.css'],
      modulePreloads: ['chunk-a.js'],
    });
    assert.match(html, /<base href="\/demo\/">/);
    assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'self'">/);
    assert.match(html, /<!-- 业务注释 -->/);
    assert.match(html, /<link rel="stylesheet" href="styles\.css">\n\s*<link rel="modulepreload" href="chunk-a\.js">\n<\/head>/);
    assert.ok(html.indexOf('polyfills.js') < html.indexOf('main.js'));
    assert.equal(html.match(/existing\.js/g).length, 1, '已存在的引用不重复注入');
  });

  test('没有 <base> 时插入；缺少显式 head/body 时报错', async () => {
    const html = await generateIndexHtml('<html><head><title>x</title></head><body></body></html>', {
      baseHref: '/',
      scripts: [],
      stylesheets: [],
      modulePreloads: [],
    });
    assert.match(html, /<head>\n\s*<base href="\/">/);
    await assert.rejects(
      generateIndexHtml('<app-root></app-root>', { baseHref: '/', scripts: [], stylesheets: [], modulePreloads: [] }),
      /显式的 <head>/,
    );
  });

  test('injectBeforeBodyEnd', async () => {
    const html = await injectBeforeBodyEnd(template, '<script src="client.js"></script>');
    assert.match(html, /<script src="client\.js"><\/script>\n<\/body>/);
  });
});

describe('collectAssets', () => {
  test('目录内容映射到输出根，冲突报错', () => {
    file('public1/images/logo.svg', 'a');
    file('public1/favicon.ico', 'b');
    file('public2/favicon.ico', 'c');
    const assets = collectAssets([path.join(tmp, 'public1')]);
    assert.deepEqual([...assets.keys()].sort(), ['favicon.ico', 'images/logo.svg']);
    assert.throws(() => collectAssets([path.join(tmp, 'public1'), path.join(tmp, 'public2')]), /资源冲突/);
  });
});
