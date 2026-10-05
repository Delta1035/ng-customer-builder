/**
 * dev-server Builder：`ng run <project>:serve-rollup[:configuration]`
 *
 *   buildTarget 选项 ──校验──▶ 归一化（强制 watch）──▶ BuildSession
 *                                                      │ watchBuilds()
 *                                                      ▼
 *                         DevServer.publish(结果) ──SSE──▶ 浏览器整页刷新 / 错误浮层
 *
 * 构建配置全部来自 buildTarget（必须是本包的 build Builder），dev-server 只增加
 * host/port/liveReload 这些服务相关选项。两者共享同一个 BuildSession 实现。
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  createBuilder,
  targetFromTargetString,
  type BuilderContext,
  type BuilderOutput,
} from '@angular-devkit/architect';
import { createAbortSignal, createLogger, reportBuildResult, resolveProjectRoot } from '../architect/builder-utils';
import { normalizeBuildOptions } from '../config/normalize';
import type { BuildBuilderOptions, DevServerBuilderOptions, NormalizedBuildOptions } from '../config/options';
import { DevServer } from '../server/dev-server';
import { BuildSession } from '../session/build-session';
import { watchBuilds } from '../session/watch-loop';

const PACKAGE_NAME: string = JSON.parse(readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).name;
const BUILD_BUILDER_NAME = `${PACKAGE_NAME}:build`;

export async function* runDevServer(options: DevServerBuilderOptions, context: BuilderContext): AsyncGenerator<BuilderOutput> {
  const logger = createLogger(context);
  const signal = createAbortSignal(context);
  const fail = (message: string): BuilderOutput => {
    logger.error(message);
    return { success: false, error: message };
  };

  if (options.hmr) {
    yield fail('首版不支持 HMR（hmr: true）。开发服务器使用整页刷新，请移除 hmr 选项。');
    return;
  }

  let buildOptions: NormalizedBuildOptions;
  try {
    buildOptions = await loadBuildTargetOptions(options.buildTarget, context);
  } catch (error) {
    yield fail(error instanceof Error ? error.message : String(error));
    return;
  }

  const server = new DevServer({
    host: options.host ?? 'localhost',
    port: options.port ?? 4200,
    baseHref: buildOptions.baseHref,
    liveReload: options.liveReload ?? true,
    logger,
  });
  context.addTeardown(() => server.close());

  let url: string;
  try {
    url = await server.listen();
  } catch (error) {
    // 端口占用等启动错误：不可恢复
    yield fail(error instanceof Error ? error.message : String(error));
    return;
  }
  logger.info(`开发服务器已启动：${url}`);

  const session = new BuildSession(buildOptions, logger);
  try {
    const builds = watchBuilds(session, signal, logger, { onBuildStart: () => server.notifyBuildStart() });
    for await (const result of builds) {
      reportBuildResult(result, logger, { fileTable: false });
      await server.publish(result);
      // 编译错误是可恢复的：报告失败，但继续监听，修复后自动恢复
      // 服务器仍在运行（失败时展示错误页），所以两种情况都报告 baseUrl
      yield {
        success: result.success,
        baseUrl: url,
        ...(result.success ? {} : { error: result.errors.join('\n') }),
      } as BuilderOutput;
    }
  } finally {
    await server.close();
  }
}

/**
 * 读取 buildTarget 的选项。为了避免「服务了一个不是本工具构建的目标」或递归调用自身，
 * 只接受本包的 build Builder。选项经过 build schema 校验（补齐默认值、拒绝未知字段）。
 */
async function loadBuildTargetOptions(buildTarget: string, context: BuilderContext): Promise<NormalizedBuildOptions> {
  const target = targetFromTargetString(buildTarget);
  const builderName = await context.getBuilderNameForTarget(target);
  if (builderName !== BUILD_BUILDER_NAME) {
    throw new Error(`buildTarget "${buildTarget}" 使用的是 "${builderName}"，dev-server 只支持 "${BUILD_BUILDER_NAME}"。`);
  }

  const rawOptions = await context.getTargetOptions(target);
  const validated = (await context.validateOptions(rawOptions, builderName)) as unknown as BuildBuilderOptions;
  return normalizeBuildOptions(
    { ...validated, watch: true },
    { workspaceRoot: context.workspaceRoot, projectRoot: await resolveProjectRoot(context, target.project) },
  );
}

export default createBuilder<DevServerBuilderOptions>(runDevServer);
