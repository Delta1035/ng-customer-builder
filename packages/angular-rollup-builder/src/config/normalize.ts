/**
 * 配置归一化与校验。
 *
 * 原则：尽早失败、明确报错，不静默忽略。
 * 所有「这个配置我们不支持」的判断都集中在这里，方便对照兼容性文档维护。
 */
import { existsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { pathKey } from '../utils/paths';
import { assertSafeOutputPath } from './output-path-safety';
import type { BuildBuilderOptions, NormalizedBuildOptions, PolyfillEntry } from './options';

export class BuildConfigError extends Error {}

/** 首版只支持纯 CSS；预处理器需要在 Angular 消费样式的阶段接入，属于明确的后续工作。 */
const UNSUPPORTED_STYLE_EXTENSIONS = new Set(['.scss', '.sass', '.less', '.styl']);

export function assertSupportedStyleFile(file: string): void {
  const ext = path.extname(file).toLowerCase();
  if (UNSUPPORTED_STYLE_EXTENSIONS.has(ext)) {
    throw new BuildConfigError(
      `不支持的样式格式 "${ext}"（${file}）。首版仅支持 .css，SCSS/Less 等预处理器尚未实现。`,
    );
  }
}

export interface NormalizeContext {
  workspaceRoot: string;
  projectRoot: string;
}

export function normalizeBuildOptions(
  options: BuildBuilderOptions,
  { workspaceRoot, projectRoot }: NormalizeContext,
): NormalizedBuildOptions {
  const resolve = (file: string) => path.resolve(workspaceRoot, file);

  const requireFile = (file: string, field: string): string => {
    const resolved = resolve(file);
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      throw new BuildConfigError(`${field}: 文件不存在 "${file}"`);
    }
    return resolved;
  };

  const entry = requireFile(options.browser, 'browser');
  const tsConfig = requireFile(options.tsConfig, 'tsConfig');
  const index = requireFile(options.index, 'index');

  const styles = (options.styles ?? []).map((style) => {
    const file = requireFile(style, 'styles');
    assertSupportedStyleFile(file);
    return file;
  });

  const assets = (options.assets ?? []).map((dir) => {
    const resolved = resolve(dir);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new BuildConfigError(`assets: "${dir}" 不是存在的目录（首版只支持目录整体复制，不支持 glob 对象）`);
    }
    return resolved;
  });

  const polyfills: PolyfillEntry[] = (options.polyfills ?? []).map((item) =>
    isPolyfillFile(item, workspaceRoot)
      ? { kind: 'file', path: requireFile(item, 'polyfills') }
      : { kind: 'module', specifier: item },
  );

  const fileReplacements = new Map<string, string>();
  for (const replacement of options.fileReplacements ?? []) {
    const from = requireFile(replacement.replace, 'fileReplacements.replace');
    const to = requireFile(replacement.with, 'fileReplacements.with');
    fileReplacements.set(pathKey(from), to);
  }

  const baseHref = normalizeBaseHref(options.baseHref ?? '/');

  const outputPath = resolve(options.outputPath);
  assertSafeOutputPath(outputPath, workspaceRoot, [
    projectRoot,
    entry,
    tsConfig,
    index,
    ...styles,
    ...assets,
    ...polyfills.flatMap((p) => (p.kind === 'file' ? [p.path] : [])),
  ]);

  return {
    workspaceRoot,
    projectRoot,
    entry,
    tsConfig,
    index,
    outputPath,
    styles,
    assets,
    polyfills,
    baseHref,
    fileReplacements,
    optimization: options.optimization ?? false,
    sourceMap: options.sourceMap ?? true,
    watch: options.watch ?? false,
  };
}

/**
 * polyfill 条目是文件还是 npm 模块？注意 "zone.js" 是包名而不是文件。
 *   - .ts/.mts 结尾、或以 ./ ../ 开头 → 文件（不存在时报错）
 *   - 工作区中存在同名文件 → 文件
 *   - 其它 → 模块说明符，交给 Rollup 的 node-resolve 解析
 */
function isPolyfillFile(item: string, workspaceRoot: string): boolean {
  if (/\.m?ts$/.test(item) || /^\.\.?[\\/]/.test(item)) {
    return true;
  }
  const candidate = path.resolve(workspaceRoot, item);
  return existsSync(candidate) && statSync(candidate).isFile();
}

/** "/demo" → "/demo/"。只接受以 / 开头的路径；CDN 绝对地址属于独立能力，首版拒绝。 */
export function normalizeBaseHref(baseHref: string): string {
  if (!baseHref.startsWith('/') || baseHref.startsWith('//')) {
    throw new BuildConfigError(`baseHref 必须是以 / 开头的路径（收到 "${baseHref}"）；首版不支持 CDN/绝对 URL。`);
  }
  return baseHref.endsWith('/') ? baseHref : `${baseHref}/`;
}
