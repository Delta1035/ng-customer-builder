/**
 * BuildSession：build 与 dev-server 两个 Builder 共享的构建核心。
 *
 * 一次 build() 按顺序执行整条流水线，产物全部在内存中：
 *
 *   ① Angular AOT 编译      AngularCompilation   .ts/.html/.css → JS（内存）
 *   ② Rollup 打包           RollupBundler        JS + node_modules → chunks（含 Linker）
 *   ③ 全局样式与媒体资源      buildGlobalStyles    styles.css + media/*
 *   ④ 静态资源               collectAssets        public/** → 输出根
 *   ⑤ index.html            generateIndexHtml    注入 base/脚本/样式
 *
 * 任一步失败，整个 build() 失败，返回的结果不含任何文件——调用方因此永远不会
 * 发布「半成品」。成功时 generation（构建代次）+1，作为一个不可变的整体交给调用方：
 * build Builder 把它原子地写入磁盘，dev-server 把它原子地替换为当前服务版本。
 *
 * 会话对象在 watch 模式下长期存在，编译器与 Rollup 的增量缓存保存在其中。
 * 调用方保证 build() 串行调用（见 watch-loop.ts），因此这里无需加锁。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { AngularCompilation } from '../compiler/angular-compilation';
import type { NormalizedBuildOptions } from '../config/options';
import type { CssAsset } from '../resources/css-processor';
import { collectAssets } from '../resources/assets';
import { buildGlobalStyles } from '../resources/global-styles';
import { generateIndexHtml } from '../resources/index-html';
import { RollupBundler } from '../rollup/bundler';
import { contentHash } from '../utils/hash';
import type { Logger } from '../utils/logger';
import type { ChangeSet } from './changes';

export interface BuildResult {
  success: boolean;
  /** 成功构建的代次；失败时为上一次成功的代次（首次失败为 0） */
  generation: number;
  /** 输出相对路径 → 内容；失败时为空 */
  files: ReadonlyMap<string, Uint8Array>;
  errors: string[];
  warnings: string[];
  durationMs: number;
  /** 各阶段耗时（毫秒），用于性能记录 */
  timings: Partial<Record<'compile' | 'bundle' | 'resources', number>>;
}

export class BuildSession {
  private readonly compilation: AngularCompilation;
  private readonly bundler: RollupBundler;
  private generation = 0;
  private lastWatchFiles = new Set<string>();

  constructor(
    readonly options: NormalizedBuildOptions,
    private readonly logger: Logger,
  ) {
    this.compilation = new AngularCompilation(options);
    this.bundler = new RollupBundler(options, this.compilation);
  }

  /** 最近一次构建涉及的所有输入文件（watcher 据此补充监听工作区外的文件） */
  get watchFiles(): string[] {
    return [...this.lastWatchFiles];
  }

  async build(changes?: ChangeSet): Promise<BuildResult> {
    const start = performance.now();
    const timings: BuildResult['timings'] = {};
    const time = async <T>(phase: keyof BuildResult['timings'], task: () => Promise<T> | T): Promise<T> => {
      const phaseStart = performance.now();
      try {
        return await task();
      } finally {
        timings[phase] = Math.round(performance.now() - phaseStart);
      }
    };
    const fail = (errors: string[], warnings: string[] = []): BuildResult => ({
      success: false,
      generation: this.generation,
      files: new Map(),
      errors,
      warnings,
      durationMs: Math.round(performance.now() - start),
      timings,
    });

    try {
      // ① Angular AOT 编译
      const compiled = await time('compile', () => this.compilation.compile(changes));
      this.rememberWatchFiles(this.compilation.watchFiles);
      if (!compiled.success) {
        return fail(compiled.errors, compiled.warnings);
      }

      // ② Rollup 打包
      const bundle = await time('bundle', () => this.bundler.bundle());
      this.rememberWatchFiles(bundle.watchFiles);
      const files = new Map(bundle.files);

      // ③ ④ ⑤ 资源与 HTML
      await time('resources', async () => {
        const stylesheets = this.addGlobalStyles(files);
        this.addMediaFiles(files, this.compilation.componentAssets);
        this.addAssets(files);

        const template = readFileSync(this.options.index, 'utf8');
        const html = await generateIndexHtml(template, {
          baseHref: this.options.baseHref,
          scripts: bundle.entryScripts,
          stylesheets,
          modulePreloads: bundle.modulePreloads,
        });
        files.set('index.html', Buffer.from(html));
      });

      this.generation++;
      return {
        success: true,
        generation: this.generation,
        files,
        errors: [],
        warnings: [...compiled.warnings, ...bundle.warnings],
        durationMs: Math.round(performance.now() - start),
        timings,
      };
    } catch (error) {
      return fail([formatError(error)]);
    }
  }

  /** ③ 全局样式 → styles.css（生产模式带内容哈希），返回需要在 HTML 中引用的样式表 */
  private addGlobalStyles(files: Map<string, Uint8Array>): string[] {
    this.rememberWatchFiles([this.options.index, ...this.options.styles]);
    const styles = buildGlobalStyles(this.options.styles, this.options.workspaceRoot);
    if (!styles) {
      return [];
    }
    this.rememberWatchFiles(styles.dependencies);
    const fileName = this.options.optimization ? `styles-${contentHash(styles.css)}.css` : 'styles.css';
    files.set(fileName, Buffer.from(styles.css));
    this.addMediaFiles(files, styles.assets);
    return [fileName];
  }

  /** 样式中 url() 引用的图片、字体 */
  private addMediaFiles(files: Map<string, Uint8Array>, assets: CssAsset[]): void {
    for (const asset of assets) {
      files.set(asset.outputPath, readFileSync(asset.sourcePath));
    }
  }

  /** ④ 静态资源目录，不允许覆盖构建生成的文件 */
  private addAssets(files: Map<string, Uint8Array>): void {
    for (const [outputPath, sourcePath] of collectAssets(this.options.assets)) {
      if (files.has(outputPath)) {
        throw new Error(`资源文件 ${sourcePath} 与构建产物 ${outputPath} 同名`);
      }
      files.set(outputPath, readFileSync(sourcePath));
    }
  }

  private rememberWatchFiles(files: Iterable<string>): void {
    for (const file of files) {
      if (!/[\\/]node_modules[\\/]/.test(file)) {
        this.lastWatchFiles.add(path.resolve(file));
      }
    }
  }
}

/** Rollup 错误带有位置与代码片段，把它们拼进消息里，方便定位 */
function formatError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const rollupError = error as Error & { id?: string; loc?: { file?: string; line: number; column: number }; frame?: string };
  const location = rollupError.loc
    ? `${rollupError.loc.file ?? rollupError.id}:${rollupError.loc.line}:${rollupError.loc.column}\n`
    : rollupError.id
      ? `${rollupError.id}\n`
      : '';
  return `${location}${error.message}${rollupError.frame ? `\n${rollupError.frame}` : ''}`;
}
