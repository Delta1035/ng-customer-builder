/**
 * Rollup 打包（流水线第 2 步）。
 *
 * 输入：Angular 编译结果（内存中）+ polyfills 虚拟入口
 * 输出：内存中的 ES 模块 chunk（含动态 import 拆出的懒加载 chunk）
 *
 * 插件顺序很重要：
 *   1. polyfills          虚拟入口
 *   2. angular-compilation 已编译的 .ts → AOT JS
 *   3. node-resolve       npm 包解析（浏览器条件、exports 字段）
 *   4. commonjs           少数 CommonJS 依赖转 ESM
 *   5. angular-linker     partial-Ivy 声明 → 完整定义
 *   6. define-globals     （生产）ngDevMode 等标记 → 常量，必须在 Linker 之后、tree-shaking 之前
 *   7. pure-annotations   （生产）Angular 框架包顶层初始化调用标记为纯函数，便于 tree-shaking
 *   (输出阶段) terser      生产模式压缩
 */
import * as path from 'node:path';
import commonjs from '@rollup/plugin-commonjs';
import { nodeResolve } from '@rollup/plugin-node-resolve';
import terser from '@rollup/plugin-terser';
import { rollup, type OutputOptions, type RollupCache, type RollupLog } from 'rollup';
import type { AngularCompilation } from '../compiler/angular-compilation';
import type { NormalizedBuildOptions } from '../config/options';
import { angularCompilationPlugin } from './angular-plugin';
import { defineGlobalsPlugin } from './define-globals-plugin';
import { angularLinkerPlugin } from './linker-plugin';
import { angularPureAnnotationsPlugin } from './pure-annotations-plugin';
import { POLYFILLS_ENTRY_ID, polyfillsPlugin } from './polyfills-plugin';

export interface BundleResult {
  /** 输出相对路径 → 内容 */
  files: Map<string, Uint8Array>;
  /** HTML 中按顺序引用的入口脚本 */
  entryScripts: string[];
  /** 首屏静态依赖，用于 <link rel="modulepreload"> */
  modulePreloads: string[];
  /** Rollup 模块图中的全部文件（watch 模式需要监听其中工作区外的部分） */
  watchFiles: string[];
  warnings: string[];
}

/**
 * 仅在生产优化时定义的编译期常量。这些是 Angular 运行时显式预留给构建工具的全局标记，
 * 定义为 false 后可以删除开发模式检查、JIT 与服务端渲染相关的代码分支（见 define-globals-plugin.ts）。
 * 刻意不做「所有 ng* 标识符替换」，只列出已确认的四个。
 */
const ANGULAR_PRODUCTION_GLOBALS = {
  ngDevMode: false,
  ngJitMode: false,
  ngI18nClosureMode: false,
  ngServerMode: false,
};

export class RollupBundler {
  /** Rollup 的增量缓存：watch 模式下未变化模块的 transform（尤其是 Linker）结果直接复用 */
  private cache?: RollupCache;

  constructor(
    private readonly options: NormalizedBuildOptions,
    private readonly compilation: AngularCompilation,
  ) {}

  async bundle(): Promise<BundleResult> {
    const { options } = this;
    const warnings: string[] = [];
    const hasPolyfills = options.polyfills.length > 0;

    const bundle = await rollup({
      input: {
        ...(hasPolyfills ? { polyfills: POLYFILLS_ENTRY_ID } : {}),
        main: options.entry,
      },
      cache: this.cache,
      // 应用而非库：入口不需要保持导出签名，Rollup 可以更自由地合并 chunk
      preserveEntrySignatures: false,
      // 不全局设置 moduleSideEffects: false —— 那会误删 polyfills、全局初始化等副作用代码
      treeshake: true,
      plugins: [
        polyfillsPlugin(options.polyfills, options.workspaceRoot),
        angularCompilationPlugin(this.compilation),
        nodeResolve({
          browser: true,
          rootDir: options.workspaceRoot,
          extensions: ['.mjs', '.js', '.json'],
          exportConditions: ['es2020', 'es2015', 'module'],
          mainFields: ['es2020', 'es2015', 'browser', 'module', 'main'],
          preferBuiltins: false,
          // 链接包/工作区库可能各自带一份 node_modules；强制 Angular 与 RxJS 只解析一份，
          // 避免页面中出现两个 Angular 运行时（DI 失效、"NG0203" 等难以排查的错误）
          dedupe: (importee) => importee.startsWith('@angular/') || importee === 'rxjs' || importee.startsWith('rxjs/'),
        }),
        commonjs(),
        angularLinkerPlugin({ sourceMap: options.sourceMap }),
        ...(options.optimization ? [defineGlobalsPlugin(ANGULAR_PRODUCTION_GLOBALS), angularPureAnnotationsPlugin()] : []),
      ],
      onLog: (level, log) => {
        if (level === 'warn' && !isIgnorableWarning(log)) {
          warnings.push(log.message);
        }
      },
    });

    try {
      this.cache = bundle.cache;
      const outputOptions: OutputOptions = {
        format: 'es',
        // 不会真的写盘，但设置 dir 让 Source Map 中的 sources 路径相对输出目录计算
        dir: options.outputPath,
        sourcemap: options.sourceMap,
        entryFileNames: options.optimization ? '[name]-[hash].js' : '[name].js',
        chunkFileNames: '[name]-[hash].js',
        plugins: options.optimization
          ? [
              terser({
                module: true,
                ecma: 2020,
                compress: { passes: 2 },
                // 'some' 保留 @license / @preserve / /*! 注释
                format: { comments: 'some' },
              }),
            ]
          : [],
      };
      const { output } = await bundle.generate(outputOptions);

      const files = new Map<string, Uint8Array>();
      const entries = new Map<string, string>();
      let mainImports: string[] = [];

      for (const item of output) {
        if (item.type === 'asset') {
          files.set(item.fileName, typeof item.source === 'string' ? Buffer.from(item.source) : item.source);
          continue;
        }
        let code = item.code;
        if (item.map) {
          const mapFileName = item.sourcemapFileName ?? `${item.fileName}.map`;
          files.set(mapFileName, Buffer.from(item.map.toString()));
          if (!code.includes('//# sourceMappingURL=')) {
            code += `\n//# sourceMappingURL=${path.posix.basename(mapFileName)}\n`;
          }
        }
        files.set(item.fileName, Buffer.from(code));
        if (item.isEntry) {
          entries.set(item.name, item.fileName);
          if (item.name === 'main') {
            mainImports = item.imports;
          }
        }
      }

      // HTML 中的脚本顺序 = 执行顺序：polyfills 必须在 main 之前
      const entryScripts = ['polyfills', 'main'].flatMap((name) => (entries.has(name) ? [entries.get(name)!] : []));
      return {
        files,
        entryScripts,
        modulePreloads: mainImports,
        watchFiles: bundle.watchFiles.filter((file) => !file.startsWith('\0')),
        warnings,
      };
    } finally {
      await bundle.close();
    }
  }
}

/** node_modules 内部的循环依赖、顶层 this 等提示对应用作者没有可操作性，过滤掉 */
function isIgnorableWarning(log: RollupLog): boolean {
  const inNodeModules = (id?: string) => !!id && /[\\/]node_modules[\\/]/.test(id);
  if (log.code === 'CIRCULAR_DEPENDENCY') {
    return (log.ids ?? []).every(inNodeModules);
  }
  if (log.code === 'THIS_IS_UNDEFINED' || log.code === 'SOURCEMAP_ERROR' || log.code === 'MODULE_LEVEL_DIRECTIVE') {
    return inNodeModules(log.id);
  }
  return false;
}
