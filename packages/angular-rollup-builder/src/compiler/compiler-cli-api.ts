/**
 * @angular/compiler-cli 适配契约。
 *
 * 本构建器只依赖 compiler-cli 根入口与 linker 入口导出的少量公开 API。这里把它们
 * 显式声明为接口，并在加载时逐一检查，原因有二：
 *
 *   1. 隔离版本风险：升级 Angular 时，只需对照这个文件确认 API 是否变化；
 *      契约测试（test/compiler-cli-contract.test.mjs）会在 API 缺失时立即失败。
 *   2. 类型可用性：compiler-cli 的 .d.ts 使用无扩展名的相对 re-export，在
 *      `moduleResolution: nodenext` + CommonJS 包下无法解析，直接导入会得到空类型。
 *
 * 已验证版本：@angular/compiler-cli 22.2.x（TypeScript 6.0）。
 * 未使用任何 private/ 或深层路径导入。
 */
import type ts from 'typescript';

export interface NgCompilerOptions extends ts.CompilerOptions {
  compilationMode?: 'full' | 'partial' | 'experimental-local';
}

export interface NgParsedConfiguration {
  project: string;
  options: NgCompilerOptions;
  rootNames: string[];
  errors: ts.Diagnostic[];
}

export interface NgResourceHostContext {
  readonly type: 'style';
  /** 外部样式文件路径；内联样式为 null */
  readonly resourceFile: string | null;
  readonly containingFile: string;
  readonly order?: number;
  className: string;
}

/** ts.CompilerHost + Angular 的资源宿主扩展（ResourceHost） */
export interface NgCompilerHost extends ts.CompilerHost {
  readResource?(fileName: string): string | Promise<string>;
  transformResource?(data: string, context: NgResourceHostContext): Promise<{ content: string } | null>;
  getModifiedResourceFiles?(): Set<string> | undefined;
}

export interface NgProgram {
  getTsProgram(): ts.Program;
  loadNgStructureAsync(): Promise<void>;
  emit(options?: { forceEmit?: boolean }): ts.EmitResult;
}

export interface AngularCompilerCliApi {
  VERSION: { full: string };
  readConfiguration(project: string, existingOptions?: NgCompilerOptions): NgParsedConfiguration;
  createCompilerHost(args: { options: NgCompilerOptions; tsHost?: ts.CompilerHost }): NgCompilerHost;
  createProgram(args: {
    rootNames: readonly string[];
    options: NgCompilerOptions;
    host: NgCompilerHost;
    oldProgram?: NgProgram;
  }): NgProgram;
  /** 与 ngc 相同的诊断收集顺序：选项 → 语法 → Angular 结构 → 语义 → 模板类型检查 */
  defaultGatherDiagnostics(program: NgProgram): readonly ts.Diagnostic[];
  formatDiagnostics(diagnostics: readonly ts.Diagnostic[], host?: ts.FormatDiagnosticsHost): string;
  /** 判断是否为 Angular 生成的类型检查 shim 文件（不是真实文件，不需要监听） */
  isShim(sourceFile: ts.SourceFile): boolean;
}

export interface AngularLinkerApi {
  /** 快速文本预检：源码是否包含需要链接的 partial 声明 */
  needsLinking(path: string, source: string): boolean;
}

export interface AngularLinkerBabelApi {
  /** Babel 插件：(api, options) => PluginObject */
  default: (...args: never[]) => unknown;
}

export const COMPILER_CLI_REQUIRED_EXPORTS = [
  'readConfiguration',
  'createCompilerHost',
  'createProgram',
  'defaultGatherDiagnostics',
  'formatDiagnostics',
  'isShim',
] as const;

/** 检查运行时导出是否满足契约；不满足时给出可操作的错误，而不是在深处抛出 "x is not a function" */
export function assertExports<T>(module: unknown, names: readonly string[], packageName: string): T {
  const missing = names.filter((name) => typeof (module as Record<string, unknown>)?.[name] !== 'function');
  if (missing.length) {
    throw new Error(
      `${packageName} 缺少本构建器依赖的导出：${missing.join(', ')}。` +
        '请确认 @angular/compiler-cli 版本与构建器的 peerDependencies 匹配（已验证 22.x）。',
    );
  }
  return module as T;
}
