/**
 * Rollup 插件：polyfills 虚拟入口。
 *
 * options.polyfills 是有序列表，例如 ["zone.js", "src/polyfills.ts"]。
 * 我们生成一个虚拟模块：
 *
 *   import "zone.js";
 *   import "D:/proj/src/polyfills.ts";
 *
 * 作为独立入口 polyfills.js 打包。ES 模块按 import 顺序执行，HTML 中 polyfills.js 的
 * <script type="module"> 排在 main.js 之前，模块脚本按文档顺序执行，所以 polyfills
 * 一定先于应用代码运行。
 *
 * 虚拟模块 id 以 \0 开头是 Rollup 约定：告诉其它插件「这不是磁盘文件，别处理它」。
 */
import * as path from 'node:path';
import type { Plugin } from 'rollup';
import type { PolyfillEntry } from '../config/options';
import { toPosixPath } from '../utils/paths';

export const POLYFILLS_ENTRY_ID = '\0ng-rollup:polyfills';

export function polyfillsPlugin(polyfills: PolyfillEntry[], workspaceRoot: string): Plugin {
  return {
    name: 'ng-rollup:polyfills',

    resolveId(source, importer) {
      if (source === POLYFILLS_ENTRY_ID) {
        return POLYFILLS_ENTRY_ID;
      }
      if (importer !== POLYFILLS_ENTRY_ID) {
        return null;
      }
      if (path.isAbsolute(source)) {
        return path.resolve(source);
      }
      // 模块说明符（如 zone.js）按「从工作区根导入」的规则解析
      return this.resolve(source, path.join(workspaceRoot, 'package.json'), { skipSelf: true });
    },

    load(id) {
      if (id !== POLYFILLS_ENTRY_ID) {
        return null;
      }
      return polyfills
        .map((p) => (p.kind === 'file' ? toPosixPath(p.path) : p.specifier))
        .map((specifier) => `import ${JSON.stringify(specifier)};`)
        .join('\n');
    },
  };
}
