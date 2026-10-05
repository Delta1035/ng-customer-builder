/**
 * 静态资源：把每个 assets 目录的内容「原样」映射到输出根目录。
 * 例如 public/images/logo.svg → <outputPath>/images/logo.svg。
 *
 * 每次构建都重新扫描目录，所以被删除的资源在下一次构建后就会从产物中消失，
 * 不会被旧文件长期掩盖。
 */
import { readdirSync } from 'node:fs';
import * as path from 'node:path';
import { toPosixPath } from '../utils/paths';

/** 返回 输出相对路径 → 源文件绝对路径 */
export function collectAssets(directories: string[]): Map<string, string> {
  const files = new Map<string, string>();

  for (const directory of directories) {
    for (const entry of readdirSync(directory, { recursive: true, withFileTypes: true })) {
      // 只复制普通文件；符号链接不跟随，避免把目录外的内容带进产物
      if (!entry.isFile()) {
        continue;
      }
      const sourcePath = path.join(entry.parentPath, entry.name);
      const outputPath = toPosixPath(path.relative(directory, sourcePath));
      const previous = files.get(outputPath);
      if (previous) {
        throw new Error(`资源冲突：${previous} 与 ${sourcePath} 都会输出到 ${outputPath}`);
      }
      files.set(outputPath, sourcePath);
    }
  }
  return files;
}
