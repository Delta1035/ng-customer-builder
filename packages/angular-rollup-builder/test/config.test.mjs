// 配置归一化、输出目录安全、依赖图单元测试。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { normalizeBuildOptions, normalizeBaseHref } = require('../dist/config/normalize.js');
const { assertSafeOutputPath } = require('../dist/config/output-path-safety.js');
const { DependencyGraph } = require('../dist/compiler/dependency-graph.js');

const ws = mkdtempSync(path.join(os.tmpdir(), 'ngr 配置 '));
after(() => rmSync(ws, { recursive: true, force: true }));
for (const f of ['app/src/main.ts', 'app/src/index.html', 'app/tsconfig.json', 'app/src/styles.css', 'app/src/env.ts', 'app/src/env.prod.ts', 'app/src/a.scss']) {
  mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
  writeFileSync(path.join(ws, f), '');
}
mkdirSync(path.join(ws, 'app/public'), { recursive: true });

const base = { browser: 'app/src/main.ts', tsConfig: 'app/tsconfig.json', index: 'app/src/index.html', outputPath: 'dist/app' };
const ctx = { workspaceRoot: ws, projectRoot: path.join(ws, 'app') };

describe('normalizeBuildOptions', () => {
  test('解析为绝对路径并分类 polyfills', () => {
    const options = normalizeBuildOptions(
      {
        ...base,
        polyfills: ['zone.js', 'app/src/env.ts'],
        assets: ['app/public'],
        fileReplacements: [{ replace: 'app/src/env.ts', with: 'app/src/env.prod.ts' }],
        baseHref: '/demo',
      },
      ctx,
    );
    assert.equal(options.entry, path.join(ws, 'app/src/main.ts'));
    assert.deepEqual(options.polyfills[0], { kind: 'module', specifier: 'zone.js' });
    assert.equal(options.polyfills[1].kind, 'file');
    assert.equal(options.baseHref, '/demo/');
    assert.equal(options.fileReplacements.size, 1);
    assert.equal(options.sourceMap, true);
    assert.equal(options.optimization, false);
  });

  test('缺失文件、预处理器样式、非目录资源被拒绝', () => {
    assert.throws(() => normalizeBuildOptions({ ...base, browser: 'nope.ts' }, ctx), /browser: 文件不存在/);
    assert.throws(() => normalizeBuildOptions({ ...base, styles: ['app/src/a.scss'] }, ctx), /不支持的样式格式/);
    assert.throws(() => normalizeBuildOptions({ ...base, assets: ['app/src/main.ts'] }, ctx), /不是存在的目录/);
  });

  test('baseHref 必须是以 / 开头的路径', () => {
    assert.equal(normalizeBaseHref('/'), '/');
    assert.throws(() => normalizeBaseHref('https://cdn.example.com/'), /不支持 CDN/);
    assert.throws(() => normalizeBaseHref('//cdn'), /不支持 CDN/);
    assert.throws(() => normalizeBaseHref('demo/'), /以 \/ 开头/);
  });
});

describe('assertSafeOutputPath', () => {
  const protectedInputs = [path.join(ws, 'app/src/main.ts'), path.join(ws, 'app')];

  test('拒绝危险目录', () => {
    assert.throws(() => assertSafeOutputPath(path.parse(ws).root, ws, protectedInputs), /文件系统根目录/);
    assert.throws(() => assertSafeOutputPath(ws, ws, protectedInputs), /工作区根目录/);
    assert.throws(() => assertSafeOutputPath(path.join(ws, '..', 'outside'), ws, protectedInputs), /工作区目录之内/);
    assert.throws(() => assertSafeOutputPath(path.join(ws, 'app'), ws, protectedInputs), /会覆盖构建输入/);
    assert.throws(() => assertSafeOutputPath(path.join(ws, 'app', 'src', 'main.ts'), ws, protectedInputs), /会覆盖构建输入/);
  });

  test('拒绝符号链接输出目录（不跟随链接删除）', (t) => {
    const link = path.join(ws, 'dist-link');
    try {
      symlinkSync(path.join(ws, 'app/public'), link, 'junction');
    } catch {
      t.skip('当前环境无法创建符号链接');
      return;
    }
    assert.throws(() => assertSafeOutputPath(link, ws, protectedInputs), /符号链接/);
  });

  test('允许普通输出目录', () => {
    assertSafeOutputPath(path.join(ws, 'dist/app'), ws, protectedInputs);
    assertSafeOutputPath(path.join(ws, 'app/dist'), ws, [path.join(ws, 'app/src/main.ts')]);
  });
});

describe('DependencyGraph', () => {
  test('传递依赖查询与依赖更新', () => {
    const graph = new DependencyGraph();
    graph.setDependencies('/p/comp.css', ['/p/theme.css', '/p/img.svg']);
    graph.setDependencies('/p/theme.css', ['/p/vars.css']);
    assert.deepEqual([...graph.ownersOf(['/p/vars.css'])].sort(), ['/p/comp.css', '/p/theme.css']);

    graph.setDependencies('/p/comp.css', ['/p/other.svg']); // 不再依赖 theme/img
    assert.deepEqual([...graph.ownersOf(['/p/img.svg'])], []);
    assert.deepEqual([...graph.ownersOf(['/p/vars.css'])], ['/p/theme.css']);
  });

  test('路径大小写与分隔符差异视为同一文件（Windows）', { skip: process.platform !== 'win32' }, () => {
    const graph = new DependencyGraph();
    graph.setDependencies('D:\\p\\comp.css', ['D:\\p\\Img.svg']);
    assert.equal(graph.ownersOf(['d:/p/img.svg']).size, 1);
  });
});
