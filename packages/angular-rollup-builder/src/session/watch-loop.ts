/**
 * watch 模式主循环（build --watch 与 dev-server 共用）。
 *
 *   ┌──────────── 初次构建 ────────────┐
 *   │                                  ▼
 *   │   等待下一批变化（去抖、合并）  ──▶  build(changes)  ──▶ yield 结果
 *   └──────────────────────────────────────────────┘
 *
 * 用 async generator 表达这个循环：调用方 `for await` 消费每一次构建结果，
 * 构建永远串行，不存在两个构建同时写同一份状态。
 * 中止信号（Ctrl+C、Architect 停止任务）会让等待立即结束，finally 中关闭 watcher。
 */
import * as path from 'node:path';
import { existsSync } from 'node:fs';
import type { Logger } from '../utils/logger';
import type { BuildResult, BuildSession } from './build-session';
import { FileWatcher } from './file-watcher';

export interface WatchHooks {
  /** 每次构建开始前调用（dev-server 用它通知浏览器「构建中」） */
  onBuildStart?(): void;
}

export async function* watchBuilds(
  session: BuildSession,
  signal: AbortSignal,
  logger: Logger,
  hooks: WatchHooks = {},
): AsyncGenerator<BuildResult> {
  const { options } = session;
  // 先启动 watcher 再做初次构建：初次构建期间发生的修改也不会丢
  const watcher = await FileWatcher.create({
    paths: [
      options.projectRoot,
      ...['angular.json', 'package.json', 'tsconfig.json']
        .map((file) => path.join(options.workspaceRoot, file))
        .filter((file) => existsSync(file)),
      options.tsConfig,
    ],
    ignoredDirectories: [options.outputPath],
  });

  try {
    hooks.onBuildStart?.();
    let result = await session.build();
    watcher.add(session.watchFiles);
    yield result;

    while (!signal.aborted) {
      const changes = await watcher.next(signal);
      if (!changes) {
        return;
      }

      if (changes.restartRequired.length) {
        const files = changes.restartRequired.map((file) => path.relative(options.workspaceRoot, file)).join(', ');
        const message = `${files} 已修改：Builder 选项或依赖可能已变化，请重启当前命令后生效。`;
        logger.warn(message);
        yield { ...result, success: false, files: new Map(), errors: [message], warnings: [] };
        if (changes.files.size === 0 && !changes.tsconfigChanged) {
          continue;
        }
      }

      const count = changes.files.size;
      logger.info(changes.tsconfigChanged ? 'tsconfig 已修改，重新初始化编译器…' : `检测到 ${count} 个文件变化，重新构建…`);
      hooks.onBuildStart?.();
      result = await session.build(changes);
      watcher.add(session.watchFiles);
      yield result;
    }
  } finally {
    await watcher.close();
  }
}
