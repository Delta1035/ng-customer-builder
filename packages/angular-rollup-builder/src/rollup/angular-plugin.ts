/**
 * Rollup 插件：把 Angular 编译结果接入 Rollup 模块图。
 *
 * Rollup 本身不认识 .ts，也不该自己去转译 .ts——那样会绕过 AOT。
 * 这个插件只做两件事：
 *   resolveId：从已编译的 .ts 文件发出的 import，用 TypeScript 的解析规则找到目标文件；
 *   load：     如果目标是已编译的 .ts 文件，返回内存中的 AOT 编译结果（JS + Source Map）。
 * 其余模块（npm 包等）交给 node-resolve / commonjs / linker 插件处理。
 */
import * as path from 'node:path';
import type { Plugin } from 'rollup';
import type { AngularCompilation } from '../compiler/angular-compilation';

export function angularCompilationPlugin(compilation: AngularCompilation): Plugin {
  return {
    name: 'ng-rollup:angular-compilation',

    resolveId(source, importer) {
      // 入口（没有 importer）：只要它是已编译的 .ts 文件，就由我们负责
      if (!importer) {
        return compilation.getEmitted(source) ? path.resolve(source) : null;
      }
      // 只处理「已编译 .ts 文件」发出的 import；node_modules 内部的 import 不归我们管
      if (!compilation.getEmitted(importer)) {
        return null;
      }
      return compilation.resolveImport(source, importer) ?? null;
    },

    load(id) {
      const emitted = compilation.getEmitted(id);
      if (!emitted) {
        return null;
      }
      return { code: emitted.code, map: emitted.map ?? null };
    },
  };
}
