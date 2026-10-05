/**
 * 配置契约。
 *
 * - BuildBuilderOptions / DevServerBuilderOptions：与 schema.json 一一对应的原始选项
 *   （Architect 已经按 schema 校验并填好默认值）。修改 schema 时请同步修改这里。
 * - NormalizedBuildOptions：流水线内部使用的形态——绝对路径、已校验、已分类。
 *   核心模块只认 NormalizedBuildOptions，不再关心路径相对于谁、字段是否缺省。
 */

export interface FileReplacement {
  replace: string;
  with: string;
}

export interface BuildBuilderOptions {
  browser: string;
  tsConfig: string;
  index: string;
  outputPath: string;
  styles?: string[];
  assets?: string[];
  polyfills?: string[];
  baseHref?: string;
  fileReplacements?: FileReplacement[];
  optimization?: boolean;
  sourceMap?: boolean;
  watch?: boolean;
}

export interface DevServerBuilderOptions {
  buildTarget: string;
  host?: string;
  port?: number;
  liveReload?: boolean;
  hmr?: boolean;
}

/** polyfill 要么是工作区里的文件，要么是 npm 模块说明符（如 zone.js）。 */
export type PolyfillEntry = { kind: 'file'; path: string } | { kind: 'module'; specifier: string };

export interface NormalizedBuildOptions {
  workspaceRoot: string;
  projectRoot: string;
  /** 应用入口 main.ts 的绝对路径 */
  entry: string;
  tsConfig: string;
  index: string;
  outputPath: string;
  styles: string[];
  assets: string[];
  polyfills: PolyfillEntry[];
  /** 总是以 / 开头并以 / 结尾 */
  baseHref: string;
  /** pathKey(被替换文件) → 替换文件的绝对路径 */
  fileReplacements: Map<string, string>;
  optimization: boolean;
  sourceMap: boolean;
  watch: boolean;
}
