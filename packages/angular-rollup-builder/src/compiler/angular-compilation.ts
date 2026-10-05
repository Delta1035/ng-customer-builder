/**
 * Angular AOT 编译（流水线第 1 步）。
 *
 * 使用 @angular/compiler-cli 导出的公开 API：
 *   readConfiguration → createProgram → loadNgStructureAsync → 收集诊断 → emit
 *
 * 与直接调用 ngc 命令行的区别：
 *   - 产物写入内存（EmittedModule），由 Rollup 插件按需读取，无需中间目录；
 *   - 保留上一次的 Program（oldProgram），Angular 与 TypeScript 都能做增量编译；
 *   - 可以挂接异步的组件样式处理（transformResource）。
 *
 * 一次 compile() 要么完全成功（诊断无错误），要么失败且不会让调用方发布新产物。
 */
import { existsSync } from 'node:fs';
import ts from 'typescript';
import type { NormalizedBuildOptions } from '../config/options';
import { processCss, type CssAsset } from '../resources/css-processor';
import type { ChangeSet } from '../session/changes';
import { loadCompilerCli } from '../utils/load-esm';
import { pathKey, toNativePath, toPosixPath } from '../utils/paths';
import type { AngularCompilerCliApi, NgCompilerHost, NgCompilerOptions, NgProgram } from './compiler-cli-api';
import { customizeCompilerHost } from './compiler-host';
import { DependencyGraph } from './dependency-graph';

export interface EmittedModule {
  code: string;
  /** JSON 格式的 Source Map（未开启 sourceMap 时为空） */
  map?: string;
}

export interface CompileResult {
  success: boolean;
  errors: string[];
  warnings: string[];
}

/** 随 tsconfig 变化而整体重建的状态 */
interface ConfigState {
  options: NgCompilerOptions;
  rootNames: string[];
  host: NgCompilerHost;
  moduleResolutionCache: ts.ModuleResolutionCache;
}

export class AngularCompilation {
  private ng?: AngularCompilerCliApi;
  private config?: ConfigState;
  private oldProgram?: NgProgram;
  /**
   * 自上一次成功分析以来变化的模板/样式文件。只在 loadNgStructureAsync 成功后清空：
   * 如果某次分析中途失败，这些变化必须保留到下一次，否则 Angular 会复用过期的分析结果。
   */
  private readonly modifiedResources = new Set<string>();

  private readonly sourceFileCache = new Map<string, ts.SourceFile>();
  /** pathKey(源 .ts) → 编译后的 JS。增量编译会跳过未变化文件的 emit，所以必须跨构建保留。 */
  private readonly emitted = new Map<string, EmittedModule>();
  /** 组件样式 → 它引用的图片/字体；键是 ownerId（见 compiler-host.ts） */
  private readonly componentStyleAssets = new Map<string, CssAsset[]>();
  private readonly resourceGraph = new DependencyGraph();

  constructor(private readonly options: NormalizedBuildOptions) {}

  async compile(changes?: ChangeSet): Promise<CompileResult> {
    this.ng ??= await loadCompilerCli();

    if (!this.config || changes?.tsconfigChanged) {
      this.reset();
      const errors = this.loadConfiguration();
      if (errors.length) {
        return { success: false, errors, warnings: [] };
      }
    } else if (changes) {
      if (changes.structural) {
        this.refreshRootNames(); // 新增/删除文件可能改变 tsconfig include 的结果
      }
      this.invalidate(changes.files);
    }

    const config = this.config!;
    let program: NgProgram;
    try {
      program = this.ng.createProgram({
        rootNames: config.rootNames,
        options: config.options,
        host: config.host,
        oldProgram: this.oldProgram,
      });
      // 异步阶段：分析所有组件、读取并转换模板/样式资源
      await program.loadNgStructureAsync();
    } catch (error) {
      // 例如样式处理失败（文件不存在、不支持的格式）。不保留这个半成品 Program。
      return { success: false, errors: [error instanceof Error ? error.message : String(error)], warnings: [] };
    }
    this.modifiedResources.clear();
    // 即使本次有诊断错误，也把它作为下一次的 oldProgram：Angular 会记录哪些文件尚未成功 emit
    this.oldProgram = program;

    const diagnostics = this.ng.defaultGatherDiagnostics(program);
    const result = this.formatDiagnostics(diagnostics);
    if (result.errors.length) {
      return { ...result, success: false };
    }

    const emitResult = program.emit();
    const emitDiagnostics = this.formatDiagnostics(emitResult.diagnostics);
    this.pruneStaleOutputs(program);

    const errors = emitDiagnostics.errors;
    return { success: errors.length === 0, errors, warnings: [...result.warnings, ...emitDiagnostics.warnings] };
  }

  /** Rollup 插件使用：取某个 .ts 文件的编译结果 */
  getEmitted(file: string): EmittedModule | undefined {
    return this.emitted.get(pathKey(file));
  }

  /**
   * Rollup 插件使用：用 TypeScript 自己的模块解析规则解析 import，
   * 保证 paths/baseUrl 等配置在「编译」与「打包」两侧解析结果一致。
   * 返回 undefined 表示交给 Rollup 的 node-resolve 处理（通常是 npm 包）。
   */
  resolveImport(specifier: string, importer: string): string | undefined {
    if (!this.config) {
      return undefined;
    }
    const { resolvedModule } = ts.resolveModuleName(
      specifier,
      toPosixPath(importer),
      this.config.options,
      this.config.host,
      this.config.moduleResolutionCache,
    );
    if (!resolvedModule) {
      return undefined;
    }
    const resolved = resolvedModule.resolvedFileName;
    if (this.emitted.has(pathKey(resolved))) {
      return toNativePath(resolved);
    }
    // TS paths 指向「已构建的库」（只有 .d.ts + .js）时，打包需要旁边的 JS 文件
    if (!resolvedModule.isExternalLibraryImport && resolved.endsWith('.d.ts')) {
      const base = resolved.slice(0, -'.d.ts'.length);
      const js = ['.mjs', '.js'].map((ext) => base + ext).find((file) => existsSync(file));
      return js ? toNativePath(js) : undefined;
    }
    return undefined;
  }

  /** 组件样式引用的所有媒体文件（输出时需要一并复制） */
  get componentAssets(): CssAsset[] {
    return [...this.componentStyleAssets.values()].flat();
  }

  /** 编译涉及的全部真实文件，供 watcher 监听（包括工作区外的链接库） */
  get watchFiles(): string[] {
    const program = this.oldProgram?.getTsProgram();
    const sources = (program?.getSourceFiles() ?? [])
      .filter((sf) => !this.ng!.isShim(sf) && !sf.fileName.includes('/node_modules/'))
      .map((sf) => toNativePath(sf.fileName));
    return [...sources, ...this.resourceGraph.allDependencies(), ...this.options.fileReplacements.values()];
  }

  // -------------------------------------------------------------------------

  private reset(): void {
    this.config = undefined;
    this.oldProgram = undefined;
    this.sourceFileCache.clear();
    this.emitted.clear();
    this.componentStyleAssets.clear();
    this.resourceGraph.clear();
    this.modifiedResources.clear();
  }

  private loadConfiguration(): string[] {
    const ng = this.ng!;
    const parsed = ng.readConfiguration(this.options.tsConfig);
    if (parsed.errors.length) {
      return parsed.errors.map((d) => ng.formatDiagnostics([d]));
    }

    let options: NgCompilerOptions;
    try {
      options = this.applyCompilerOverrides(parsed.options);
    } catch (error) {
      return [(error as Error).message];
    }
    const host = customizeCompilerHost(ng.createCompilerHost({ options }), ts, {
      fileReplacements: this.options.fileReplacements,
      sourceFileCache: this.sourceFileCache,
      getModifiedResourceFiles: () => (this.oldProgram ? this.modifiedResources : undefined),
      onEmit: (sourceFile, outputFileName, text) => this.recordEmit(sourceFile, outputFileName, text),
      transformComponentStyle: (css, ownerFile, ownerId) => this.transformComponentStyle(css, ownerFile, ownerId),
    });

    this.config = {
      options,
      rootNames: this.withExtraRootNames(parsed.rootNames),
      host,
      moduleResolutionCache: ts.createModuleResolutionCache(this.options.workspaceRoot, (f) => pathKey(f), options),
    };
    return [];
  }

  private refreshRootNames(): void {
    const parsed = this.ng!.readConfiguration(this.options.tsConfig);
    this.config!.rootNames = this.withExtraRootNames(parsed.rootNames);
    this.config!.moduleResolutionCache.clear();
  }

  /** 入口与 polyfill 文件即使不在 tsconfig include 中也必须参与编译 */
  private withExtraRootNames(rootNames: string[]): string[] {
    const extra = [this.options.entry, ...this.options.polyfills.flatMap((p) => (p.kind === 'file' ? [p.path] : []))];
    const byKey = new Map(rootNames.map((name) => [pathKey(name), name]));
    for (const file of extra) {
      if (!byKey.has(pathKey(file))) {
        byKey.set(pathKey(file), toPosixPath(file));
      }
    }
    return [...byKey.values()];
  }

  /**
   * 构建器必须控制的编译选项。用户 tsconfig 中的类型检查相关设置全部保留，
   * 只覆盖「输出形态」相关项。
   */
  private applyCompilerOverrides(options: NgCompilerOptions): NgCompilerOptions {
    const moduleKind = options.module;
    const esmKinds = [ts.ModuleKind.ES2015, ts.ModuleKind.ES2020, ts.ModuleKind.ES2022, ts.ModuleKind.ESNext, ts.ModuleKind.Preserve];
    if (moduleKind !== undefined && !esmKinds.includes(moduleKind)) {
      throw new Error(`tsconfig 的 module 必须输出 ES 模块（当前为 ${ts.ModuleKind[moduleKind]}），Rollup 依赖静态/动态 import 拆包`);
    }

    const target = options.target === undefined || options.target < ts.ScriptTarget.ES2022 ? ts.ScriptTarget.ES2022 : options.target;
    return {
      ...options,
      // 应用必须完整 AOT 编译（partial 仅用于发布库）
      compilationMode: 'full',
      // 与 Angular CLI 一致：ES2022 + useDefineForClassFields=false，保证类字段与 DI 语义
      target,
      useDefineForClassFields: false,
      // 输出形态：只要 JS（+ Source Map），写入内存
      noEmit: false,
      noEmitOnError: false,
      emitDeclarationOnly: false,
      declaration: false,
      declarationMap: false,
      composite: false,
      incremental: false,
      tsBuildInfoFile: undefined,
      // 不设 outDir：Source Map 中的 sources 才会是相对源文件目录的正确路径
      outDir: undefined,
      sourceMap: this.options.sourceMap,
      inlineSourceMap: false,
      inlineSources: this.options.sourceMap,
      mapRoot: undefined,
      sourceRoot: undefined,
    };
  }

  /** 文件变化 → 失效对应缓存，并计算出需要告知 Angular 的「已修改资源」。 */
  private invalidate(changedFiles: Set<string>): void {
    const affected = new Set([...changedFiles, ...this.resourceGraph.ownersOf(changedFiles)]);

    for (const file of affected) {
      const key = pathKey(file);
      this.sourceFileCache.delete(key);
      // 替换文件（environment.prod.ts）变化 → 被替换文件（environment.ts）的缓存也失效
      for (const [replacedKey, replacement] of this.options.fileReplacements) {
        if (pathKey(replacement) === key) {
          this.sourceFileCache.delete(replacedKey);
        }
      }
      if (!/\.[cm]?tsx?$/.test(file)) {
        this.modifiedResources.add(toPosixPath(file)); // Angular 内部使用正斜杠路径
      }
    }
    this.config!.moduleResolutionCache.clear();
  }

  private transformComponentStyle(css: string, ownerFile: string, ownerId: string): string {
    const result = processCss(css, ownerFile);
    this.componentStyleAssets.set(ownerId, result.assets);
    this.resourceGraph.setDependencies(ownerFile, result.dependencies);
    return result.css;
  }

  private recordEmit(sourceFile: string, outputFileName: string, text: string): void {
    const key = pathKey(sourceFile);
    const entry = this.emitted.get(key) ?? { code: '' };
    if (outputFileName.endsWith('.map')) {
      entry.map = text;
    } else {
      // 去掉 sourceMappingURL 注释：Source Map 由 Rollup 统一串联输出
      entry.code = text.replace(/^\/\/# sourceMappingURL=.*$/m, '');
      if (!this.options.sourceMap) {
        entry.map = undefined;
      }
    }
    this.emitted.set(key, entry);
  }

  /** 删除/重命名的文件不能留在内存产物中，否则会被 Rollup 继续打包 */
  private pruneStaleOutputs(program: NgProgram): void {
    const live = new Set(program.getTsProgram().getSourceFiles().map((sf) => pathKey(sf.fileName)));
    for (const key of this.emitted.keys()) {
      if (!live.has(key)) {
        this.emitted.delete(key);
      }
    }
    for (const ownerId of this.componentStyleAssets.keys()) {
      const ownerFile = ownerId.split('#')[0];
      if (!existsSync(ownerFile)) {
        this.componentStyleAssets.delete(ownerId);
      }
    }
  }

  private formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): { errors: string[]; warnings: string[] } {
    const format = (d: ts.Diagnostic) =>
      this.ng!.formatDiagnostics([d], {
        getCurrentDirectory: () => this.options.workspaceRoot,
        getCanonicalFileName: (f) => f,
        getNewLine: () => '\n',
      }).trim();
    return {
      errors: diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error).map(format),
      warnings: diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Warning).map(format),
    };
  }
}
