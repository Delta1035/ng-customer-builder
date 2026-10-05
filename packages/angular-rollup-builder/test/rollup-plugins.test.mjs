// Rollup 插件单元测试 + @angular/compiler-cli 契约测试。
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { describe, test } from 'node:test';

const require = createRequire(import.meta.url);
const { rollup } = require('rollup');
const { defineGlobalsPlugin } = require('../dist/rollup/define-globals-plugin.js');
const { angularPureAnnotationsPlugin } = require('../dist/rollup/pure-annotations-plugin.js');
const { COMPILER_CLI_REQUIRED_EXPORTS } = require('../dist/compiler/compiler-cli-api.js');
const { loadCompilerCli, loadLinker, loadLinkerBabel } = require('../dist/utils/load-esm.js');

/** 用虚拟模块运行一次 Rollup，返回某个插件对指定代码的 transform 结果 */
async function transformWith(plugin, code, id = '/virtual/entry.js') {
  const bundle = await rollup({
    input: id,
    treeshake: false,
    plugins: [{ name: 'virtual', resolveId: (s) => (s === id ? id : null), load: (i) => (i === id ? code : null) }, plugin],
  });
  const { output } = await bundle.generate({ format: 'es' });
  await bundle.close();
  return output[0].code;
}

describe('defineGlobalsPlugin', () => {
  const plugin = () => defineGlobalsPlugin({ ngDevMode: false });

  test('替换全局读取与 typeof，不替换属性名', async () => {
    const code = await transformWith(
      plugin(),
      [
        'export const a = (typeof ngDevMode === "undefined" || ngDevMode) && check();',
        'export const b = window.ngDevMode;',
        'export const c = { ngDevMode: 1 };',
        'export const d = { ngDevMode };',
        'function check() {}',
      ].join('\n'),
    );
    assert.match(code, /const a = \("boolean" === "undefined" \|\| false\) && check\(\);/);
    assert.match(code, /window\.ngDevMode/);
    assert.match(code, /\{ ngDevMode: 1 \}/);
    assert.match(code, /\{ ngDevMode: false \}/);
  });

  test('文件自身声明或赋值同名变量时整体跳过', async () => {
    const declared = await transformWith(plugin(), 'let ngDevMode = true; export const x = ngDevMode;');
    assert.match(declared, /const x = ngDevMode;/);
    const assigned = await transformWith(plugin(), 'ngDevMode = {}; export const x = ngDevMode;');
    assert.match(assigned, /const x = ngDevMode;/);
  });
});

describe('angularPureAnnotationsPlugin', () => {
  test('只为 sideEffects:false 的 @angular 包的顶层变量初始化调用加纯函数标记', async () => {
    const coreFile = require.resolve('@angular/core/package.json').replace('package.json', 'fesm2022/x.mjs');
    const source = 'const A = make(); export const B = new Token(); register(); function make() {} class Token {} function register() {} export { A };';
    const code = await transformWith(angularPureAnnotationsPlugin(), source, coreFile);
    assert.match(code, /const A = \/\*@__PURE__\*\/ make\(\);/);
    assert.match(code, /const B = \/\*@__PURE__\*\/ new Token\(\);/);
    assert.doesNotMatch(code, /__PURE__\*\/ register\(\)/, '顶层表达式语句不标记');

    const userCode = await transformWith(angularPureAnnotationsPlugin(), source, '/project/src/x.js');
    assert.doesNotMatch(userCode, /__PURE__/, '非 Angular 包不处理');
  });
});

describe('@angular/compiler-cli 契约', () => {
  test('构建器依赖的导出在当前安装版本中存在', async () => {
    const ng = await loadCompilerCli(); // 缺失时 assertExports 会抛出明确错误
    for (const name of COMPILER_CLI_REQUIRED_EXPORTS) {
      assert.equal(typeof ng[name], 'function', name);
    }
    assert.match(ng.VERSION.full, /^22\./, '已验证的大版本');
    assert.equal(typeof (await loadLinker()).needsLinking, 'function');
    assert.equal(typeof (await loadLinkerBabel()).default, 'function');
  });

  test('needsLinking 能识别 partial 声明', async () => {
    const { needsLinking } = await loadLinker();
    assert.equal(needsLinking('/x.mjs', 'i0.ɵɵngDeclareComponent({ minVersion: "14.0.0" })'), true);
    assert.equal(needsLinking('/x.mjs', 'export const x = 1;'), false);
  });
});
