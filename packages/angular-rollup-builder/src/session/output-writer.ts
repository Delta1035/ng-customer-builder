/**
 * 把一个完整的构建代次写入磁盘（仅 build Builder 使用；dev-server 只在内存中服务）。
 *
 * 「原子替换」流程：
 *   1. 全部文件写入同级的临时目录  <outputPath>.ngr-staging-*
 *   2. 旧的 outputPath 改名为      <outputPath>.ngr-old-*
 *   3. 临时目录改名为 outputPath
 *   4. 删除旧目录
 * 任何一步之前失败，旧产物都保持完整；不会出现「一半新一半旧」的输出目录。
 *
 * Windows 上目录被资源管理器、杀毒软件或静态服务器占用时 rename 可能短暂失败（EPERM/EBUSY），
 * 因此带重试；重试仍失败时退化为「清空后复制」，并给出警告。
 *
 * outputPath 的安全性（不是工作区根、不包含源码等）已在配置归一化阶段校验。
 */
import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '../utils/logger';

const STAGING_MARKER = '.ngr-staging-';
const OLD_MARKER = '.ngr-old-';

export async function writeOutputDirectory(outputPath: string, files: ReadonlyMap<string, Uint8Array>, logger: Logger): Promise<void> {
  const parent = path.dirname(outputPath);
  const baseName = path.basename(outputPath);
  await mkdir(parent, { recursive: true });
  await removeLeftovers(parent, baseName);

  const suffix = `${process.pid}-${Date.now()}`;
  const staging = path.join(parent, `${baseName}${STAGING_MARKER}${suffix}`);
  const old = path.join(parent, `${baseName}${OLD_MARKER}${suffix}`);

  try {
    for (const [relativePath, contents] of files) {
      const target = path.join(staging, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents);
    }

    const hadPrevious = existsSync(outputPath);
    if (hadPrevious) {
      await renameWithRetry(outputPath, old);
    }
    try {
      await renameWithRetry(staging, outputPath);
    } catch (error) {
      if (hadPrevious) {
        await renameWithRetry(old, outputPath).catch(() => {});
      }
      throw error;
    }
    await rm(old, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    if (!isBusyError(error) || !existsSync(staging)) {
      throw error;
    }
    logger.warn(`无法原子替换 ${outputPath}（目录被占用），改为清空后复制。`);
    await copyInPlace(staging, outputPath);
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 5 });
  }
}

async function renameWithRetry(from: string, to: string, attempts = 6): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !isBusyError(error)) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50 * 2 ** attempt));
    }
  }
}

async function copyInPlace(staging: string, outputPath: string): Promise<void> {
  await mkdir(outputPath, { recursive: true });
  for (const entry of await readdir(outputPath)) {
    await rm(path.join(outputPath, entry), { recursive: true, force: true, maxRetries: 5 });
  }
  await cp(staging, outputPath, { recursive: true });
}

/** 清理之前崩溃留下的临时目录（只匹配本工具的命名前缀） */
async function removeLeftovers(parent: string, baseName: string): Promise<void> {
  for (const entry of await readdir(parent)) {
    if (entry.startsWith(`${baseName}${STAGING_MARKER}`) || entry.startsWith(`${baseName}${OLD_MARKER}`)) {
      await rm(path.join(parent, entry), { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
  }
}

function isBusyError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES' || code === 'ENOTEMPTY';
}
