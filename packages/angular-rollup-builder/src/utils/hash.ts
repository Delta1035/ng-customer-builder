import { createHash } from 'node:crypto';

/** 内容哈希（8 位十六进制），用于生产文件名缓存失效。 */
export function contentHash(contents: string | Uint8Array): string {
  return createHash('sha256').update(contents).digest('hex').slice(0, 8);
}
