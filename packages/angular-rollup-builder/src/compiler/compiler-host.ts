/**
 * 编译器宿主（CompilerHost）定制。
 *
 * Angular 编译器通过宿主读写文件。我们在 ng.createCompilerHost() 的默认宿主上
 * 覆盖几个方法，就把构建器需要的能力「插」进了编译过程：
 *
 *   getSourceFile / readFile   → 文件替换 + SourceFile 缓存（增量编译依赖缓存命中）
 *   readResource               → 读取 templateUrl/styleUrl，拒绝不支持的样式格式
 *   transformResource          → 组件样式处理（@import 内联、url() 改写）
 *   getModifiedResourceFiles   → 告诉 Angular 本次哪些 HTML/CSS 变了
 *   writeFile                  → 编译产物写入内存，而不是写磁盘
 *
 * 文件替换在这一层实现，是为了让「类型检查」和「代码生成」看到同一份内容；
 * Rollup 随后加载的也是这份编译结果，因此三者天然一致（规格 6.3）。
 */
import { readFileSync } from 'node:fs';
import type ts from 'typescript';
import { assertSupportedStyleFile } from '../config/normalize';
import { pathKey } from '../utils/paths';
import type { NgCompilerHost } from './compiler-cli-api';

export interface CompilerHostHooks {
  /** pathKey(被替换文件) → 替换文件绝对路径 */
  fileReplacements: ReadonlyMap<string, string>;
  /** pathKey → SourceFile；由 AngularCompilation 在文件变化时失效 */
  sourceFileCache: Map<string, ts.SourceFile>;
  getModifiedResourceFiles(): Set<string> | undefined;
  /** 一个源文件的编译输出（.js 或 .js.map） */
  onEmit(sourceFile: string, outputFileName: string, text: string): void;
  /**
   * 处理组件样式，返回最终 CSS。
   * @param ownerFile 样式所在文件：外部样式为 .css 文件，内联样式为所属 .ts 文件
   * @param ownerId   同一文件中可能有多段内联样式，用它区分
   */
  transformComponentStyle(css: string, ownerFile: string, ownerId: string): string;
}

export function customizeCompilerHost(host: NgCompilerHost, tsModule: typeof ts, hooks: CompilerHostHooks): NgCompilerHost {
  const { fileReplacements, sourceFileCache } = hooks;
  const readReplaced = (fileName: string): string | undefined => {
    const replacement = fileReplacements.get(pathKey(fileName));
    return replacement === undefined ? undefined : readFileSync(replacement, 'utf8');
  };

  const baseGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile) => {
    const key = pathKey(fileName);
    const cached = sourceFileCache.get(key);
    if (cached && !shouldCreateNewSourceFile) {
      return cached;
    }

    const replacedText = readReplaced(fileName);
    const sourceFile =
      replacedText === undefined
        ? baseGetSourceFile(fileName, languageVersionOrOptions, onError, shouldCreateNewSourceFile)
        : // 注意：文件名仍是原文件名，内容来自替换文件。import 关系与源码映射都保持不变。
          tsModule.createSourceFile(fileName, replacedText, languageVersionOrOptions, true);

    if (sourceFile) {
      sourceFileCache.set(key, sourceFile);
    }
    return sourceFile;
  };

  const baseReadFile = host.readFile.bind(host);
  host.readFile = (fileName) => readReplaced(fileName) ?? baseReadFile(fileName);

  host.readResource = (fileName) => {
    assertSupportedStyleFile(fileName);
    return readFileSync(fileName, 'utf8');
  };

  host.transformResource = async (data, context) => {
    if (context.type !== 'style') {
      return null;
    }
    const ownerFile = context.resourceFile ?? context.containingFile;
    const ownerId = context.resourceFile ?? `${context.containingFile}#${context.className}#${context.order ?? 0}`;
    return { content: hooks.transformComponentStyle(data, ownerFile, ownerId) };
  };

  host.getModifiedResourceFiles = () => hooks.getModifiedResourceFiles();

  host.writeFile = (fileName, text, _writeBOM, _onError, sourceFiles) => {
    const source = sourceFiles?.[0];
    if (source) {
      hooks.onEmit(source.fileName, fileName, text);
    }
  };

  return host;
}
