/**
 * 文件监听：把零散的文件系统事件合并成一个个 ChangeSet。
 *
 * 设计要点：
 *   - 整个构建只有这一个 watcher。编译器和 Rollup 都不自己监听文件，
 *     避免「两个 watcher 各自触发一条流水线」的竞争。
 *   - 去抖：最后一个事件之后安静 debounceMs 才视为一批变化结束（编辑器保存常常产生多个事件）。
 *   - 构建进行中到达的事件只会累积，等调用方下一次 next() 时一次性取走——
 *     因此构建天然串行，旧构建永远不会覆盖新构建。
 */
import * as path from 'node:path';
import { emptyChangeSet, type ChangeSet } from './changes';
import { loadChokidar } from '../utils/load-esm';
import { isPathInside } from '../utils/paths';

type ChokidarWatcher = ReturnType<Awaited<ReturnType<typeof loadChokidar>>['watch']>;

export interface FileWatcherOptions {
  /** 递归监听的目录或单个文件 */
  paths: string[];
  /** 不监听的目录（输出目录等） */
  ignoredDirectories: string[];
  debounceMs?: number;
}

/** 改动后需要重启进程才能生效的文件 */
const RESTART_FILES = new Set(['angular.json', 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
const IGNORED_SEGMENTS = /[\\/](node_modules|\.git|\.angular|\.cache)([\\/]|$)/;

export class FileWatcher {
  private pending = emptyChangeSet();
  private settled = false;
  private timer?: NodeJS.Timeout;
  private waiter?: (changes: ChangeSet | null) => void;
  private readonly watched = new Set<string>();

  private constructor(
    private readonly watcher: ChokidarWatcher,
    private readonly debounceMs: number,
  ) {}

  static async create({ paths, ignoredDirectories, debounceMs = 120 }: FileWatcherOptions): Promise<FileWatcher> {
    const chokidar = await loadChokidar();
    const watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      ignored: (file: string) =>
        IGNORED_SEGMENTS.test(file) ||
        ignoredDirectories.some((dir) => isPathInside(file, dir) || path.basename(file).startsWith(`${path.basename(dir)}.ngr-`)),
    });
    const instance = new FileWatcher(watcher, debounceMs);
    paths.forEach((p) => instance.watched.add(path.resolve(p)));
    watcher.on('all', (event: string, file: string) => instance.record(event, file));
    await new Promise<void>((resolve) => watcher.once('ready', () => resolve()));
    return instance;
  }

  /** 补充监听（例如工作区外的链接库文件）；已覆盖的路径会被跳过 */
  add(files: Iterable<string>): void {
    const added: string[] = [];
    for (const file of files) {
      const resolved = path.resolve(file);
      if (![...this.watched].some((root) => isPathInside(resolved, root))) {
        this.watched.add(resolved);
        added.push(resolved);
      }
    }
    if (added.length) {
      this.watcher.add(added);
    }
  }

  /** 等待下一批变化；signal 中止时返回 null */
  next(signal: AbortSignal): Promise<ChangeSet | null> {
    if (signal.aborted) {
      return Promise.resolve(null);
    }
    if (this.settled) {
      return Promise.resolve(this.take());
    }
    return new Promise((resolve) => {
      const onAbort = () => {
        this.waiter = undefined;
        resolve(null);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiter = (changes) => {
        signal.removeEventListener('abort', onAbort);
        resolve(changes);
      };
    });
  }

  async close(): Promise<void> {
    clearTimeout(this.timer);
    this.waiter?.(null);
    await this.watcher.close();
  }

  // -------------------------------------------------------------------------

  private record(event: string, file: string): void {
    const absolute = path.resolve(file);
    const name = path.basename(absolute);

    if (RESTART_FILES.has(name)) {
      if (!this.pending.restartRequired.includes(absolute)) {
        this.pending.restartRequired.push(absolute);
      }
    } else if (/^tsconfig.*\.json$/.test(name)) {
      this.pending.tsconfigChanged = true;
    } else {
      if (event !== 'change') {
        this.pending.structural = true; // add / unlink / addDir / unlinkDir
      }
      if (event !== 'addDir' && event !== 'unlinkDir') {
        this.pending.files.add(absolute);
      }
    }
    this.settled = false;

    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.settled = true;
      if (this.waiter) {
        const waiter = this.waiter;
        this.waiter = undefined;
        waiter(this.take());
      }
    }, this.debounceMs);
  }

  private take(): ChangeSet {
    const changes = this.pending;
    this.pending = emptyChangeSet();
    this.settled = false;
    return changes;
  }
}
