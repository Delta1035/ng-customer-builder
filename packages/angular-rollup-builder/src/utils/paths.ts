/**
 * 路径工具。
 *
 * 同一个文件在不同工具里会有不同写法：
 *   TypeScript/Angular: D:/proj/src/app.ts
 *   Rollup/chokidar:    D:\proj\src\app.ts
 *   某些调用方：         d:\proj\src\app.ts
 * 所有「用路径做 Map 键」的地方都必须先经过 pathKey()，否则 Windows 上会出现
 * 「明明是同一个文件却查不到」的问题（文件替换失效、重建不触发等）。
 */
import * as path from 'node:path';

const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';

/** 归一化为当前平台的绝对路径（Windows 下使用反斜杠）。 */
export function toNativePath(file: string): string {
  return path.resolve(file);
}

/** 转为正斜杠形式。Angular 编译器内部使用这种格式。 */
export function toPosixPath(file: string): string {
  return file.replace(/\\/g, '/');
}

/** 用于 Map/Set 键的规范路径：绝对路径 + 正斜杠 + （大小写不敏感平台）小写。 */
export function pathKey(file: string): string {
  const key = toPosixPath(path.resolve(file));
  return caseInsensitive ? key.toLowerCase() : key;
}

/** child 是否位于 parent 目录之内（或相等）。 */
export function isPathInside(child: string, parent: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 输出文件路径（相对输出根、正斜杠），例如 media/logo-1a2b3c4d.svg。 */
export function toOutputPath(...segments: string[]): string {
  return toPosixPath(path.posix.join(...segments.map(toPosixPath)));
}
