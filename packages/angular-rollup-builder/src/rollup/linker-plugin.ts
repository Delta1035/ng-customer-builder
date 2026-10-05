/**
 * Rollup 插件：Angular Linker。
 *
 * npm 上的 Angular 库（包括 @angular/core、@angular/router 自身）以 partial 模式发布，
 * 代码里是 ɵɵngDeclareComponent(...) 这样的「声明」，需要 Linker 把它们转成
 * 完整的 AOT 定义（ɵɵdefineComponent）。不链接的话，运行时会要求 JIT 编译器并报错。
 *
 * 处理范围：所有 JS 模块都检查，不排除 node_modules（链接需求恰恰主要来自 node_modules）。
 * needsLinking() 是 Linker 提供的快速文本预检（是否包含声明调用），
 * 只有命中的文件才交给 Babel，所以全量检查的代价很低。
 *
 * Rollup 的 transform 缓存（bundle.cache）会在 watch 模式下复用链接结果。
 */
import type { PluginItem } from '@babel/core' with { 'resolution-mode': 'import' };
import type { Plugin } from 'rollup';
import { loadBabel, loadLinker, loadLinkerBabel } from '../utils/load-esm';

export interface LinkerPluginOptions {
  sourceMap: boolean;
}

export function angularLinkerPlugin({ sourceMap }: LinkerPluginOptions): Plugin {
  return {
    name: 'ng-rollup:angular-linker',

    async transform(code, id) {
      if (!/\.[cm]?js$/.test(id)) {
        return null;
      }
      const { needsLinking } = await loadLinker();
      if (!needsLinking(id, code)) {
        return null;
      }

      const [babel, linkerBabel] = await Promise.all([loadBabel(), loadLinkerBabel()]);
      const result = await babel.transformAsync(code, {
        filename: id,
        // 隔离用户的 babel 配置：这里只做链接，不做其它转换
        babelrc: false,
        configFile: false,
        compact: false,
        sourceMaps: sourceMap,
        plugins: [
          [
            linkerBabel.default,
            {
              // 产物不得依赖浏览器 JIT 补救
              linkerJitMode: false,
              sourceMapping: sourceMap,
            },
          ] as PluginItem,
        ],
      });
      if (!result?.code) {
        throw new Error(`Angular Linker 处理失败：${id}`);
      }
      return { code: result.code, map: (result.map as never) ?? null };
    },
  };
}
