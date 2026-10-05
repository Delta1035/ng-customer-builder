/**
 * 输出目录安全检查。
 *
 * 构建会「整目录替换」outputPath，一旦配置错误（例如写成 "." 或 "src"），
 * 就可能删除源码。所以在任何写盘之前先拒绝危险路径：
 *   1. 盘符根 / 文件系统根
 *   2. 工作区根本身，或工作区之外的目录
 *   3. 包含任何源码输入（入口、tsconfig、index.html、样式、资源目录……）的目录
 *   4. 已存在但是符号链接的目录（避免删除跟随到链接目标）
 */
import { lstatSync } from 'node:fs';
import * as path from 'node:path';
import { isPathInside } from '../utils/paths';

export class UnsafeOutputPathError extends Error {}

export function assertSafeOutputPath(outputPath: string, workspaceRoot: string, protectedInputs: string[]): void {
  const resolved = path.resolve(outputPath);
  const display = isPathInside(resolved, workspaceRoot) ? path.relative(workspaceRoot, resolved) || '.' : resolved;
  const reject = (reason: string): never => {
    throw new UnsafeOutputPathError(`outputPath "${display}" 不安全：${reason}`);
  };

  if (path.parse(resolved).root === resolved) {
    reject('不能是文件系统根目录');
  }
  if (path.resolve(workspaceRoot) === resolved) {
    reject('不能是工作区根目录');
  }
  if (!isPathInside(resolved, workspaceRoot)) {
    reject('必须位于工作区目录之内');
  }
  for (const input of protectedInputs) {
    if (isPathInside(input, resolved)) {
      reject(`会覆盖构建输入 ${path.relative(workspaceRoot, input)}`);
    }
  }

  let stats;
  try {
    stats = lstatSync(resolved);
  } catch {
    return; // 不存在：安全
  }
  if (stats.isSymbolicLink()) {
    reject('它是一个符号链接，清理时可能越界');
  }
  if (!stats.isDirectory()) {
    reject('已存在且不是目录');
  }
}
