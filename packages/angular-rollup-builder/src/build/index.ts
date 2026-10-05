/**
 * build Builder：`ng run <project>:build-rollup[:configuration]`
 *
 * 这一层很薄，只负责：
 *   读取并校验选项 → 创建 BuildSession → 单次构建或 watch 循环 → 写盘 → 报告结果
 * 真正的构建逻辑全部在 BuildSession 中，与 dev-server 共享。
 */
import { createBuilder, type BuilderContext, type BuilderOutput } from '@angular-devkit/architect';
import { createAbortSignal, createLogger, reportBuildResult, resolveProjectRoot } from '../architect/builder-utils';
import { normalizeBuildOptions } from '../config/normalize';
import type { BuildBuilderOptions, NormalizedBuildOptions } from '../config/options';
import { BuildSession, type BuildResult } from '../session/build-session';
import { writeOutputDirectory } from '../session/output-writer';
import { watchBuilds } from '../session/watch-loop';

export async function* runBuild(rawOptions: BuildBuilderOptions, context: BuilderContext): AsyncGenerator<BuilderOutput> {
  const logger = createLogger(context);
  const signal = createAbortSignal(context);

  let options: NormalizedBuildOptions;
  try {
    options = normalizeBuildOptions(rawOptions, {
      workspaceRoot: context.workspaceRoot,
      projectRoot: await resolveProjectRoot(context),
    });
  } catch (error) {
    // 配置错误：不可恢复，直接失败退出
    const message = error instanceof Error ? error.message : String(error);
    logger.error(message);
    yield { success: false, error: message };
    return;
  }

  const session = new BuildSession(options, logger);
  const results = options.watch ? watchBuilds(session, signal, logger) : singleBuild(session);

  for await (const result of results) {
    reportBuildResult(result, logger, { fileTable: !options.watch || result.generation === 1 });
    if (!result.success) {
      // 构建失败：不触碰输出目录，上一次的成功产物保持原样
      yield { success: false, error: result.errors.join('\n') };
      continue;
    }
    try {
      await writeOutputDirectory(options.outputPath, result.files, logger);
      logger.info(`输出目录：${options.outputPath}`);
      yield { success: true, outputPath: options.outputPath } as BuilderOutput;
    } catch (error) {
      const message = `写入输出目录失败：${error instanceof Error ? error.message : error}`;
      logger.error(message);
      yield { success: false, error: message };
    }
  }
}

async function* singleBuild(session: BuildSession): AsyncGenerator<BuildResult> {
  yield await session.build();
}

export default createBuilder<BuildBuilderOptions>(runBuild);
