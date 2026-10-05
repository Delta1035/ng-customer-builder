/**
 * 示例 polyfill：记录执行时间戳。
 * main.ts 启动前会检查它，用于验证「polyfills 先于应用执行」这一输出契约。
 */
(globalThis as Record<string, unknown>)['__polyfillLoadedAt'] = performance.now();
