/**
 * 公共入口：导出 Builder 处理函数与核心构建会话，便于在 Architect 之外复用或测试。
 * Angular CLI 通过 builders.json 加载 dist/build/index.js 与 dist/dev-server/index.js，不经过这里。
 */
export { runBuild } from './build/index';
export { runDevServer } from './dev-server/index';
export { normalizeBuildOptions, BuildConfigError } from './config/normalize';
export type { BuildBuilderOptions, DevServerBuilderOptions, NormalizedBuildOptions } from './config/options';
export { BuildSession, type BuildResult } from './session/build-session';
export { DevServer } from './server/dev-server';
