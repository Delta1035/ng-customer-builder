/**
 * 全局样式：把 options.styles 中的文件按顺序合并为一个 styles.css。
 *
 * 实现技巧：构造一个虚拟入口，内容是按顺序 `@import` 每个全局样式文件，
 * 然后交给 processCss 处理。这样「顺序合并、@import 内联、url 改写、远程 @import 提升」
 * 全部复用同一套逻辑，没有第二份实现需要维护。
 *
 * 全局样式每次构建都完整重新处理（代价很小），因此不需要增量依赖跟踪。
 */
import * as path from 'node:path';
import { processCss, type ProcessedCss } from './css-processor';
import { toPosixPath } from '../utils/paths';

export function buildGlobalStyles(files: string[], workspaceRoot: string): ProcessedCss | null {
  if (files.length === 0) {
    return null;
  }
  // 使用正斜杠绝对路径：CSS 字符串中的反斜杠是转义符
  const entry = files.map((file) => `@import "${toPosixPath(file)}";`).join('\n');
  return processCss(entry, path.join(workspaceRoot, '__global-styles__.css'));
}
