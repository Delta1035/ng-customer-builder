/**
 * Architect 适配层：把 Angular CLI 的 BuilderContext 转换成核心模块需要的东西。
 * 核心（session/compiler/rollup/server）不依赖 @angular-devkit/architect，
 * 这样它们可以被单独测试，也不会因 Architect API 变化而大面积改动。
 */
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { BuilderContext } from '@angular-devkit/architect';
import type { BuildResult } from '../session/build-session';
import type { Logger } from '../utils/logger';

export function createLogger(context: BuilderContext): Logger {
  return {
    info: (message) => context.logger.info(message),
    warn: (message) => context.logger.warn(message),
    error: (message) => context.logger.error(message),
  };
}

/**
 * Architect 停止任务（Ctrl+C、取消订阅、run.stop()）时会调用 teardown。
 * 把它转换成标准的 AbortSignal，watch 循环据此退出等待并清理资源。
 */
export function createAbortSignal(context: BuilderContext): AbortSignal {
  const controller = new AbortController();
  context.addTeardown(() => controller.abort());
  return controller.signal;
}

export async function resolveProjectRoot(context: BuilderContext, project = context.target?.project): Promise<string> {
  if (!project) {
    throw new Error('该 Builder 必须通过项目目标调用（例如 ng run my-app:build-rollup）');
  }
  const metadata = await context.getProjectMetadata(project);
  return path.resolve(context.workspaceRoot, typeof metadata['root'] === 'string' ? metadata['root'] : '');
}

/** 把一次构建结果输出到终端 */
export function reportBuildResult(result: BuildResult, logger: Logger, options: { fileTable: boolean }): void {
  result.warnings.forEach((warning) => logger.warn(warning));
  if (!result.success) {
    result.errors.forEach((error) => logger.error(error));
    logger.error(`✘ 构建失败（${result.durationMs} ms）`);
    return;
  }
  if (options.fileTable) {
    logger.info(formatFileTable(result.files));
  }
  const { compile = 0, bundle = 0, resources = 0 } = result.timings;
  logger.info(
    `✔ 构建成功 #${result.generation}（${result.durationMs} ms：编译 ${compile} / 打包 ${bundle} / 资源 ${resources}）`,
  );
}

function formatFileTable(files: ReadonlyMap<string, Uint8Array>): string {
  const rows = [...files]
    .filter(([name]) => /\.(js|css|html)$/.test(name))
    .map(([name, contents]) => ({ name, raw: contents.byteLength, gzip: gzipSync(contents).byteLength }))
    .sort((a, b) => b.raw - a.raw);
  const width = Math.max(...rows.map((row) => row.name.length), 4);
  const kb = (bytes: number) => `${(bytes / 1024).toFixed(2)} kB`.padStart(11);
  const total = rows.reduce((sum, row) => ({ raw: sum.raw + row.raw, gzip: sum.gzip + row.gzip }), { raw: 0, gzip: 0 });
  return [
    `${'File'.padEnd(width)} | ${'Raw'.padStart(11)} | ${'Gzip'.padStart(11)}`,
    ...rows.map((row) => `${row.name.padEnd(width)} | ${kb(row.raw)} | ${kb(row.gzip)}`),
    `${'Total'.padEnd(width)} | ${kb(total.raw)} | ${kb(total.gzip)}`,
  ].join('\n');
}
