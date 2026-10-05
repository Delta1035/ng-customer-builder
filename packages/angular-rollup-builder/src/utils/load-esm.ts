/**
 * ESM 依赖加载集中点。
 *
 * 为什么需要它：Architect 用 `require()` 加载 Builder 实现，所以本包编译为 CommonJS。
 * 但 @angular/compiler-cli、@babel/core 8、chokidar 5、parse5 8 都是纯 ESM 包，
 * 不能直接 `require`。TypeScript 在 `module: nodenext` + CJS 输出下会原样保留 `import()`，
 * 因此这里用动态 import 加载它们。
 *
 * 把所有 ESM 加载放在一个文件里，升级依赖或切换模块格式时只需改这一处。
 */
import {
  assertExports,
  COMPILER_CLI_REQUIRED_EXPORTS,
  type AngularCompilerCliApi,
  type AngularLinkerApi,
  type AngularLinkerBabelApi,
} from '../compiler/compiler-cli-api';

const cache = new Map<string, Promise<unknown>>();

/** 每个模块只加载一次 */
function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  let pending = cache.get(key) as Promise<T> | undefined;
  if (!pending) {
    pending = load();
    cache.set(key, pending);
  }
  return pending;
}

export const loadCompilerCli = () =>
  once('compiler-cli', async () =>
    assertExports<AngularCompilerCliApi>(await import('@angular/compiler-cli'), COMPILER_CLI_REQUIRED_EXPORTS, '@angular/compiler-cli'),
  );

export const loadLinker = () =>
  once('linker', async () =>
    assertExports<AngularLinkerApi>(await import('@angular/compiler-cli/linker'), ['needsLinking'], '@angular/compiler-cli/linker'),
  );

export const loadLinkerBabel = () =>
  once('linker-babel', async () =>
    assertExports<AngularLinkerBabelApi>(await import('@angular/compiler-cli/linker/babel'), ['default'], '@angular/compiler-cli/linker/babel'),
  );

export const loadBabel = () => once('babel', () => import('@babel/core'));
export const loadChokidar = () => once('chokidar', () => import('chokidar'));
export const loadParse5 = () => once('parse5', () => import('parse5'));
